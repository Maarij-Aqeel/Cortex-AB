import { useMemo } from "react";
import type { ClipState, RegionGroup, SlotId } from "../types";
import { formatValue, windowMean } from "../lib/data";

interface Props {
  clips: Record<SlotId, ClipState>;
  groups: RegionGroup[];
  hookS: number;
}

interface Row {
  key: string;
  label: string;
  blurb: string;
  a: number | null;
  b: number | null;
  diff: number | null;
}

export default function HookTable({ clips, groups, hookS }: Props) {
  const sa = clips.A.summary;
  const sb = clips.B.summary;

  const rows = useMemo<Row[]>(() => {
    const regions = [
      ...groups.map((g) => ({ key: g.key, label: g.label, blurb: g.blurb })),
      { key: "overall", label: "Whole cortex", blurb: "Mean over every cortical vertex." },
    ];
    const out = regions.map((r) => {
      const a = sa ? windowMean(sa.times, sa.rois[r.key], hookS) : null;
      const b = sb ? windowMean(sb.times, sb.rois[r.key], hookS) : null;
      return { ...r, a, b, diff: a !== null && b !== null ? a - b : null };
    });
    if (sa && sb) out.sort((x, y) => Math.abs(y.diff!) - Math.abs(x.diff!));
    return out;
  }, [sa, sb, groups, hookS]);

  const maxDiff = Math.max(1e-6, ...rows.map((r) => Math.abs(r.diff ?? 0)));
  const both = Boolean(sa && sb);

  return (
    <section className="panel hook" aria-labelledby="hook-title">
      <h2 id="hook-title">First {hookS} seconds</h2>
      <p className="panel-note">
        Mean predicted activity per region while the hook plays.
        {both ? " Sorted by the size of the gap between A and B." : " Add a second clip to compare."}
      </p>
      {!sa && !sb ? (
        <p className="empty">Analyse a clip to fill this table.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Region</th>
              <th scope="col" className="num">A</th>
              <th scope="col" className="num">B</th>
              <th scope="col" className="gap-col">Gap (A − B)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const lead: SlotId | null = r.diff === null ? null : r.diff >= 0 ? "A" : "B";
              const width = r.diff === null ? 0 : (Math.abs(r.diff) / maxDiff) * 50;
              return (
                <tr key={r.key} className={r.key === "overall" ? "is-total" : undefined}>
                  <th scope="row" title={r.blurb}>{r.label}</th>
                  <td className="num">{r.a === null ? "–" : formatValue(r.a)}</td>
                  <td className="num">{r.b === null ? "–" : formatValue(r.b)}</td>
                  <td className="gap-col">
                    {r.diff !== null && lead && (
                      <div className="gap">
                        <div className="gap-track" aria-hidden>
                          <span
                            className={`gap-bar gap-${lead.toLowerCase()}`}
                            style={lead === "A" ? { left: "50%", width: `${width}%` } : { right: "50%", width: `${width}%` }}
                          />
                        </div>
                        <span className="gap-value">
                          {formatValue(r.diff)} <span className="muted">{lead} higher</span>
                        </span>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="panel-foot">
        Units are the model's predicted fMRI signal for an average viewer. Compare A with B inside a row; rows have
        different baselines.
      </p>
    </section>
  );
}
