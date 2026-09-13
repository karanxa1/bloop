// TEMPORARY test harness for the marketplace (UI-C) — delete after verification.
import { createRoot } from "react-dom/client";
import "./index.css";
import { MarketplaceModal } from "./components/MarketplaceModal";
import type { MarketTab } from "./types/marketplace";

const p = new URLSearchParams(window.location.search);
const t = p.get("tab");
const tab: MarketTab = t === "tools" || t === "skills" ? t : "apps";

createRoot(document.getElementById("root")!).render(
  <MarketplaceModal onClose={() => console.log("closed")} initialTab={tab} connectedId={p.get("connected")} />
);
