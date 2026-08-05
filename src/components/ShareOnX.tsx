import { brand } from '../brand.js';

/** X (Twitter) share button — opens the intent composer with a pre-filled tweet.
 *  Mirrors the pattern from ar-io-solana-registration-app. */
export function ShareOnX({ text, url, style }: { text: string; url: string; style?: React.CSSProperties }) {
  const onClick = () => {
    const q = `text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    window.open(`https://x.com/intent/tweet?${q}`, '_blank', 'noopener');
  };
  return (
    <button type="button" onClick={onClick} className="share-x-btn" style={{ ...btn, ...style }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
      </svg>
      Share on X
    </button>
  );
}

const btn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  padding: '10px 18px',
  borderRadius: '9999px',
  border: `1px solid ${brand.border}`,
  background: brand.black,
  color: brand.white,
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: '14px',
  fontWeight: 600,
  cursor: 'pointer',
};
