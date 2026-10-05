export function PlaceholderPage(props: { title: string; milestone: string }) {
  return (
    <>
      <header className="page-header">
        <h1>{props.title}</h1>
      </header>
      <div className="page-body">
        <div className="empty-state">
          <p>Coming in the {props.milestone} milestone.</p>
        </div>
      </div>
    </>
  );
}
