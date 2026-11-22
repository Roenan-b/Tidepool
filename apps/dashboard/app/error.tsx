'use client';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="desktop">
      <main id="main">
        <section className="window narrow" aria-label="Error">
          <header className="titlebar">
            <div className="titlebar-title">
              <strong>Something went wrong</strong>
            </div>
          </header>
          <div className="window-body stack">
            <p>The dashboard hit an unexpected error. No action was taken on your behalf.</p>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={reset}>
                Try again
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full reload resets state after an error */}
              <a className="btn" href="/">
                Go home
              </a>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
