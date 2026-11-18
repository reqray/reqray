/**
 * Exports: taking a session out of the panel.
 *
 * HAR and cURL are built here rather than in the browser because the panel
 * only ever receives list rows — bodies and headers live in the records, and
 * an export that quietly dropped them would be worse than no export.
 *
 * Both formats are for handing a request to something else: a HAR to a
 * browser's network panel or a colleague's viewer, a curl script to a
 * terminal. Neither is a backup format, and neither promises to round-trip.
 */

import type { RecordedRequest } from '../types.js';

/** Reqray's own additions to a HAR entry, under the extension prefix HAR reserves. */
interface ReqrayHarExtension {
  readonly sqlQueries: number;
  readonly nPlusOne: boolean;
  readonly test: string | null;
}

function headerList(headers: Readonly<Record<string, string>>): Array<{
  name: string;
  value: string;
}> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

/** HAR 1.2. Times are milliseconds, as the format requires. */
export function toHar(
  requests: readonly RecordedRequest[],
  now = new Date(0),
  note: string | null = null,
): Record<string, unknown> {
  return {
    log: {
      version: '1.2',
      creator: { name: 'reqray', version: '0.1' },
      pages: [],
      entries: requests.map((request) => {
        const extension: ReqrayHarExtension = {
          sqlQueries: request.spans.filter((span) => span.kind === 'db').length,
          nPlusOne: request.findings.some((finding) => finding.detector === 'n_plus_one'),
          test: request.test,
        };

        return {
          startedDateTime: new Date(request.startedAt).toISOString(),
          time: request.durationMs,
          request: {
            method: request.method,
            url: `${request.path}${request.query ? `?${request.query}` : ''}`,
            httpVersion: 'HTTP/1.1',
            headers: headerList(request.requestHeaders),
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: request.requestBody?.text.length ?? 0,
            ...(request.requestBody
              ? {
                  postData: {
                    mimeType: request.requestHeaders['content-type'] ?? 'application/json',
                    text: request.requestBody.text,
                  },
                }
              : {}),
          },
          response: {
            status: request.status,
            statusText: '',
            httpVersion: 'HTTP/1.1',
            headers: headerList(request.responseHeaders),
            cookies: [],
            content: {
              size: request.responseBody?.text.length ?? 0,
              mimeType: request.responseHeaders['content-type'] ?? 'application/json',
              ...(request.responseBody ? { text: request.responseBody.text } : {}),
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: request.responseBody?.text.length ?? 0,
          },
          cache: {},
          // Everything Reqray knows lands in `wait`: the breakdown it has is by
          // span, not by the connection phases HAR describes.
          timings: { send: 0, wait: request.durationMs, receive: 0 },
          _reqray: extension,
        };
      }),
      // Kept out of the entries so a diff of two exports stays readable.
      _exportedAt: now.toISOString(),
      // HAR's own field for this, so a viewer that knows nothing of Reqray
      // still shows it. An export that was cut has to say so: it is evidence,
      // and evidence presented as complete is worse than none.
      ...(note ? { comment: note } : {}),
    },
  };
}

/** Escapes a value for single-quoted shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A runnable `.sh`: one curl per request.
 *
 * Masked headers and bodies are exported as they were stored — with the
 * masking. A script that leaked the authorization header of every recorded
 * request would undo the one guarantee the buffer makes.
 */
export function toCurlScript(
  requests: readonly RecordedRequest[],
  origin: string,
  note: string | null = null,
): string {
  const lines = [
    '#!/bin/sh',
    '# Exported from reqray. Sensitive headers and fields are masked, so a',
    '# request that needed them will not authenticate as it did.',
    // At the top rather than the bottom: a script is read from the first line,
    // and "this is not all of them" belongs where reading starts.
    ...(note ? [`# ${note}`] : []),
    '',
  ];

  for (const request of requests) {
    const url = `${origin}${request.path}${request.query ? `?${request.query}` : ''}`;
    const parts = [`curl -i -X ${request.method} ${shellQuote(url)}`];
    for (const [name, value] of Object.entries(request.requestHeaders)) {
      // Hop-by-hop and length headers are curl's business, not the script's.
      if (name === 'host' || name === 'content-length' || name === 'connection') continue;
      parts.push(`  -H ${shellQuote(`${name}: ${value}`)}`);
    }
    if (request.requestBody) parts.push(`  --data ${shellQuote(request.requestBody.text)}`);

    lines.push(
      // One line, whatever the name holds: a record can come off the wire, and
      // a line break here would end the comment and start a command.
      `# ${request.status} · ${Math.round(request.durationMs)} ms${request.test ? ` · ${request.test.replace(/\p{Cc}/gu, ' ')}` : ''}`,
      parts.join(' \\\n'),
      '',
    );
  }

  return lines.join('\n');
}
