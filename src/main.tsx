import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

document.getElementById("boot-status")?.remove();

class StartupErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: Error | null }
> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("React render failed", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return <CrashScreen title="React render failed" detail={formatStartupError(this.state.error)} />;
    }

    return this.props.children;
  }
}

function CrashScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        margin: 0,
        padding: "24px",
        background: "#111827",
        color: "#f9fafb",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <h1 style={{ margin: "0 0 16px", fontSize: "20px" }}>{title}</h1>
      <pre
        style={{
          margin: 0,
          padding: "16px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          background: "#030712",
          border: "1px solid #374151",
          borderRadius: "8px",
        }}
      >
        {detail}
      </pre>
    </div>
  );
}

function formatStartupError(error: unknown) {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

function renderFatalStartupError(title: string, error: unknown) {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }

  ReactDOM.createRoot(root).render(
    <CrashScreen title={title} detail={formatStartupError(error)} />,
  );
}

window.addEventListener("error", (event) => {
  console.error("Window error", event.error ?? event.message);
  renderFatalStartupError("Window error", event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled rejection", event.reason);
  renderFatalStartupError("Unhandled promise rejection", event.reason);
});

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

try {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <StartupErrorBoundary>
        <App />
      </StartupErrorBoundary>
    </React.StrictMode>,
  );
} catch (error) {
  console.error("Startup render failed", error);
  renderFatalStartupError("Startup render failed", error);
}
