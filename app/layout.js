export const metadata = { title: 'Farm pH' };

export default function RootLayout({ children }) {
  return (
    <html lang="da">
      <body style={{
        margin: 0,
        fontFamily: 'system-ui, sans-serif',
        background: '#0f1115',
        color: '#e8eaed'
      }}>
        {children}
      </body>
    </html>
  );
}
