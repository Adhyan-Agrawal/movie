import { StrictMode, useEffect, version } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { PlayerShell } from '@/features/player/PlayerShell';
import { NativePlayer } from '@/features/player/NativePlayer';
import { NativeDomStub } from './boundaries.jsx';

function FixtureRoot({ props }) {
  useEffect(() => { window.__playerFixture.commits += 1; }, []);
  return <PlayerShell {...props} />;
}

function tree(props, strict) {
  const content = <FixtureRoot props={props} />;
  return strict ? <StrictMode>{content}</StrictMode> : content;
}

export function renderMarkup(props, strict = false) {
  return renderToString(tree(props, strict), { identifierPrefix: 'private-fixture-' });
}

export function renderNativeContract(props) {
  return {
    actual: renderToString(<NativePlayer {...props} />),
    stub: renderToString(<NativeDomStub {...props} />),
  };
}

function diagnostic(error, info) {
  return {
    name: error?.name,
    message: String(error?.message ?? error),
    stack: error?.stack ?? null,
    cause: error?.cause ? String(error.cause?.stack ?? error.cause) : null,
    componentStack: info?.componentStack ?? null,
  };
}

let root;
export function hydrate(props, strict = false) {
  const state = window.__playerFixture;
  const container = document.getElementById('private-fixture-root');
  state.propsJSON = JSON.stringify(props);
  state.reactVersion = version;
  state.rootBefore = container.outerHTML;
  root = hydrateRoot(container, tree(props, strict), {
    identifierPrefix: 'private-fixture-',
    onRecoverableError: (error, info) => state.recoverable.push(diagnostic(error, info)),
    onUncaughtError: (error, info) => state.uncaught.push(diagnostic(error, info)),
    onCaughtError: (error, info) => state.caught.push(diagnostic(error, info)),
  });
}

export function unmount() { root?.unmount(); }
export { version };

if (typeof window !== 'undefined') {
  window.PlayerHydrationFixture = { renderMarkup, renderNativeContract, hydrate, unmount, version };
}
