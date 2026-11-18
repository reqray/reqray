interface EmptyStateProps {
  error: string | null;
}

export function EmptyState({ error }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty-card">
        <div className="empty-head">
          <span className="pulse" />
          {error
            ? `collector unreachable — ${error}`
            : 'collector attached — waiting for the first request'}
        </div>
        <div className="empty-body">
          <h1 className="empty-title">No requests recorded yet</h1>
          <p className="empty-text">
            Reqray is listening on the application it was attached to. Hit any route and it will
            appear here instantly.
          </p>
          <div className="empty-label">TRY IT</div>
          <div className="snippet">curl -s localhost:3000/api/orders | jq</div>
          <div className="snippet s-fg2">{'// or just reload your app in the browser'}</div>
        </div>
      </div>
    </div>
  );
}
