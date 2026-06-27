import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { fetchConfig } from "./api";

const rootEl = document.getElementById("root")!;
const root = createRoot(rootEl);

function Fatal({ message }: { message: string }) {
  return (
    <div style={{ font: "14px system-ui", padding: 24, color: "#b00" }}>
      ux load error: {message}
    </div>
  );
}

fetchConfig()
  .then((config) => {
    root.render(
      <StrictMode>
        <App config={config} />
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    root.render(<Fatal message={message} />);
  });
