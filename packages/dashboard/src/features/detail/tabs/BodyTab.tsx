import type { RequestDetail } from '../../../api/index';

/** Bodies are stored as text; JSON among them is re-indented for reading. */
function prettyBody(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

interface BodyTabProps {
  detail: RequestDetail;
}

export function BodyTab({ detail }: BodyTabProps) {
  const body = detail.responseBody;
  if (!body) {
    return <p className="s-dim mono">response body was not captured</p>;
  }
  return (
    <div>
      <div className="label">
        RESPONSE BODY · {detail.responseHeaders['content-type'] ?? 'unknown'} ·{' '}
        {/* The collector's own measurement, not the text's: a truncated body
            measured here would report the capture limit as the body size. */}
        {(body.bytes / 1024).toFixed(1)} KB
        {body.truncated ? ' · truncated' : ''}
      </div>
      <pre className="json-block">{prettyBody(body.text)}</pre>
    </div>
  );
}
