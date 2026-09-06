'use client';

import { cn } from '@/lib/cn';

/**
 * Adsterra banner unit (Spec Section 11).
 *
 * Adsterra's embed sets a global `atOptions` then loads an invoke.js that
 * document.writes an iframe. Two units on one page would therefore clobber
 * each other's options — so each unit is isolated in its own about:srcdoc
 * iframe containing the full stock snippet. The srcdoc inherits the page CSP,
 * so the invoke host must be allowlisted in next.config.mjs (it is).
 *
 * If the zone key is missing the parent renders a labeled placeholder instead
 * (see AdSlot); this component is only used with a real key.
 */
export function AdsterraBanner({
  adsterraKey,
  width,
  height,
  className,
}: {
  adsterraKey: string;
  width: number;
  height: number;
  className?: string;
}) {
  // Adsterra's stock banner snippet, verbatim, parameterized by the zone key.
  const srcDoc = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}</style></head>
<body>
<script type="text/javascript">
  atOptions = {
    'key': '${adsterraKey}',
    'format': 'iframe',
    'height': ${height},
    'width': ${width},
    'params': {}
  };
</script>
<script type="text/javascript" src="//www.highperformanceformat.com/${adsterraKey}/invoke.js"></script>
</body>
</html>`;

  return (
    <div
      className={cn('mx-auto flex items-center justify-center', className)}
      style={{ width: '100%', maxWidth: width }}
    >
      <iframe
        title={`Advertisement (${width}×${height})`}
        srcDoc={srcDoc}
        width={width}
        height={height}
        scrolling="no"
        frameBorder={0}
        // Never let the ad frame script Lumora or submit forms.
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        className="border-0 bg-transparent"
      />
    </div>
  );
}
