import { memo, useMemo, useState, type MouseEvent } from "react";
import type { ClipState, RegionGroup, SlotId, Summary } from "../types";
import { formatTime, formatValue, seriesAt } from "../lib/data";

interface Props {
  clips: Record<SlotId, ClipState>;
  groups: RegionGroup[];
  duration: number;
  hookS: number;
  time: number;
  onSeek: (t: number) => void;
}

const W = 300;
const H = 110;
const IDS = ["A", "B"] as const;

type Summaries = Partial<Record<SlotId, Summary>>;

function downloadCsv(summaries: Summaries, groups: RegionGroup[]) {
  const keys = [...groups.map((g) => g.key), "overall"];
  const lines = ["clip,time_s,region,value"];
  for (const id of IDS) {
    const s = summaries[id];
    if (!s) continue;
    for (const key of keys) {
      s.rois[key].forEach((v, i) => lines.push(`${id},${s.times[i]},${key},${v}`));
    }
  }
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "tribe-region-timelines.csv";
  a.click();
  URL.revokeObjectURL(url);
}

interface ChartProps {
  group: RegionGroup;
  summaries: Summaries;
  duration: number;
  hookS: number;
  time: number;
  hover: { t: number; key: string } | null;
  onHover: (h: { t: number; key: string } | null) => void;
  onSeek: (t: number) => void;
}

const RegionChart = memo(function RegionChart(p: ChartProps) {
  const { group, summaries, duration, hookS, time, hover, onHover, onSeek } = p;
  const hoverT = hover?.t ?? null;

  const geom = useMemo(() => {
    const all = IDS.flatMap((id) => summaries[id]?.rois[group.key] ?? []);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    const pad = (hi - lo || 1) * 0.12;
    lo -= pad;
    hi += pad;
    const y = (v: number) => (1 - (v - lo) / (hi - lo)) * H;
    const x = (t: number) => (t / duration) * W;
    const paths: Partial<Record<SlotId, string>> = {};
    const ends: Partial<Record<SlotId, number>> = {};
    for (const id of IDS) {
      const s = summaries[id];
      if (!s) continue;
      const values = s.rois[group.key];
      paths[id] = values.map((v, i) => `${i ? "L" : "M"}${x(s.times[i]).toFixed(1)},${y(v).toFixed(1)}`).join("");
      ends[id] = (y(values[values.length - 1]) / H) * 100;
    }
    // Keep the two end labels from overlapping.
    if (ends.A !== undefined && ends.B !== undefined && Math.abs(ends.A - ends.B) < 14) {
      const mid = (ends.A + ends.B) / 2;
      const [up, down] = ends.A <= ends.B ? (["A", "B"] as const) : (["B", "A"] as const);
      ends[up] = mid - 7;
      ends[down] = mid + 7;
    }
    const zeroY = lo < 0 && hi > 0 ? y(0) : null;
    return { lo, hi, paths, ends, zeroY };
  }, [summaries, group.key, duration]);

  const pct = (t: number) => `${Math.min(100, (t / duration) * 100)}%`;
  const tAt = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((e.clientX - rect.left) / rect.width) * duration));
  };

  return (
    <figure className="region">
      <figcaption>
        <span className="region-name">{group.label}</span>
        <span className="region-blurb">{group.blurb}</span>
      </figcaption>
      <div className="region-body">
        <div className="region-y" aria-hidden>
          <span>{formatValue(geom.hi)}</span>
          <span>{formatValue(geom.lo)}</span>
        </div>
        <div
          className="region-plot"
          onPointerMove={(e) => onHover({ t: tAt(e), key: group.key })}
          onPointerLeave={() => onHover(null)}
          onClick={(e) => onSeek(tAt(e))}
        >
          <div className="region-hook" style={{ width: pct(hookS) }} aria-hidden />
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${group.label}: predicted activity over time for each clip`}>
            {geom.zeroY !== null && <line className="zero" x1={0} x2={W} y1={geom.zeroY} y2={geom.zeroY} />}
            {IDS.map((id) => geom.paths[id] && <path key={id} d={geom.paths[id]} className={`line line-${id.toLowerCase()}`} />)}
          </svg>
          <div className="region-head" style={{ left: pct(time) }} aria-hidden />
          {IDS.map(
            (id) =>
              geom.ends[id] !== undefined && (
                <span key={id} className={`end-label end-${id.toLowerCase()}`} style={{ top: `${geom.ends[id]}%` }} aria-hidden>
                  {id}
                </span>
              ),
          )}
          {hoverT !== null && <div className="region-cross" style={{ left: pct(hoverT) }} aria-hidden />}
          {hoverT !== null && hover?.key === group.key && (
            <>
              <div className={`region-tip${hoverT > duration * 0.6 ? " is-left" : ""}`} style={{ left: pct(hoverT) }}>
                <span className="muted">{formatTime(hoverT)}</span>
                {IDS.map(
                  (id) =>
                    summaries[id] && (
                      <span key={id}>
                        <i className={`swatch swatch-${id.toLowerCase()}`} aria-hidden />
                        {id} {formatValue(seriesAt(summaries[id]!.times, summaries[id]!.rois[group.key], hoverT))}
                      </span>
                    ),
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </figure>
  );
});

export default function RegionGrid({ clips, groups, duration, hookS, time, onSeek }: Props) {
  const [hover, setHover] = useState<{ t: number; key: string } | null>(null);
  const summaries = useMemo<Summaries>(() => {
    const out: Summaries = {};
    for (const id of IDS) if (clips[id].summary) out[id] = clips[id].summary!;
    return out;
  }, [clips.A.summary, clips.B.summary]);
  const hasData = Object.keys(summaries).length > 0 && duration > 0;

  return (
    <section className="panel regions" aria-labelledby="regions-title">
      <div className="panel-head">
        <div>
          <h2 id="regions-title">Region timelines</h2>
          <p className="panel-note">
            Predicted activity per brain system across the clip. The shaded band is the hook window; click a chart to
            jump there.
          </p>
        </div>
        <div className="panel-tools">
          <span className="legend">
            <span><i className="swatch swatch-a" aria-hidden /> Clip A</span>
            <span><i className="swatch swatch-b" aria-hidden /> Clip B</span>
          </span>
          <button type="button" className="btn-quiet" disabled={!hasData} onClick={() => downloadCsv(summaries, groups)}>
            Download CSV
          </button>
        </div>
      </div>
      {hasData ? (
        <div className="region-grid">
          {groups.map((g) => (
            <RegionChart
              key={g.key}
              group={g}
              summaries={summaries}
              duration={duration}
              hookS={hookS}
              time={time}
              hover={hover}
              onHover={setHover}
              onSeek={onSeek}
            />
          ))}
        </div>
      ) : (
        <p className="empty">Nine brain systems will be charted here, one small chart each.</p>
      )}
      {hasData && (
        <p className="panel-foot">
          Time runs left to right from 0:00 to {formatTime(duration)}. Each chart has its own vertical scale.
        </p>
      )}
    </section>
  );
}
