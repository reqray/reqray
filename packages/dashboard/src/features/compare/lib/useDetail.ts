/** One request in full, re-read when the id changes; `null` while it loads. */

import { useEffect, useState } from 'react';
import { fetchRequest, type RequestDetail } from '../../../api/index';

export function useDetail(id: string | null): {
  detail: RequestDetail | null;
  error: string | null;
} {
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    fetchRequest(id, controller.signal)
      .then(setDetail)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [id]);

  return { detail, error };
}
