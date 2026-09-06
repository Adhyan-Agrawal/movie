import type { Metadata } from 'next';
import { Container } from '@/components/ui/Container';

export const metadata: Metadata = {
  robots: { index: true, follow: true },
};

/** Shared reading layout for legal pages (Section 15). */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <Container className="py-10">
      <article className="prose-lumora mx-auto flex max-w-2xl flex-col gap-4 text-sm leading-relaxed text-content-muted">
        {children}
      </article>
    </Container>
  );
}
