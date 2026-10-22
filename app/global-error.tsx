"use client";

// No shared providers, styles or chart imports: this also survives a layout error.
export default function GlobalError() {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
        <main role="alert">
          <h1>Portfolio could not load</h1>
          <p>Reload to get the latest version</p>
          <button type="button" onClick={() => window.location.reload()} style={{ padding: "12px 20px" }}>Reload page</button>
        </main>
      </body>
    </html>
  );
}
