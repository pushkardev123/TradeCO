import "./globals.css";

export const metadata = {
  title: "TradeCO",
  description: "Binance Spot Testnet trading terminal",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
