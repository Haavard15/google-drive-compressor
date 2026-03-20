import type { Metadata } from 'next';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Drive Compressor | Video Storage Manager',
  description: 'Analyze, compress, and manage your Google Drive video storage',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-void-900 text-zinc-100 min-h-screen">
        {/* Background effects */}
        <div className="fixed inset-0 bg-grid-pattern bg-grid opacity-30 pointer-events-none" />
        <div className="fixed inset-0 bg-gradient-to-br from-neon-purple/5 via-transparent to-neon-cyan/5 pointer-events-none" />
        
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
