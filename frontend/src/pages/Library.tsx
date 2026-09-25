import { useSearchParams } from "react-router-dom";
import { Explorer } from "../components/explorer/Explorer";
import { FullHeight } from "../components/Layout";
import { usePlexStatus, useScan } from "../lib/plex";

export function Library() {
  const [params, setParams] = useSearchParams();
  const path = params.get("path") || "library";
  const scan = useScan();
  const plex = usePlexStatus();

  return (
    <FullHeight>
      <Explorer
        path={path}
        onNavigate={(p) => setParams(p === "library" ? {} : { path: p })}
        onScan={() => scan.mutate(undefined)}
        scanning={scan.isPending || !!plex.data?.refreshing}
      />
    </FullHeight>
  );
}
