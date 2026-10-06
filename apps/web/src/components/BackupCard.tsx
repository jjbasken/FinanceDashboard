import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { formatDate } from "../ledger";

interface BackupStatus {
  enabled: boolean;
  latest: { name: string; date: string; size: number } | null;
  count: number;
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function BackupCard(props: { isOwner: boolean }) {
  const status = useQuery({ queryKey: ["backup", "status"], queryFn: () => api.get<BackupStatus>("/backup/status") });
  const s = status.data;
  return (
    <section className="card">
      <h2>Backups</h2>
      {status.error && <p className="error-text">{status.error.message}</p>}
      {s && !s.enabled && <p className="muted">Nightly backups are turned off on this server.</p>}
      {s?.enabled && (
        <p className="muted">
          {s.latest
            ? `A copy of everything is saved each night on the server. The latest is from ${formatDate(s.latest.date)} (${megabytes(s.latest.size)}); ${s.count} kept.`
            : "A copy of everything is saved each night on the server. The first one hasn't been made yet."}
        </p>
      )}
      {props.isOwner ? (
        <div>
          <a className="btn" href="/api/backup/download" download>
            Download a backup now
          </a>
        </div>
      ) : (
        <p className="muted">The household owner can download a backup.</p>
      )}
    </section>
  );
}
