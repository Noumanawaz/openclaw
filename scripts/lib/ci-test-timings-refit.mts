import { stripVTControlCharacters } from "node:util";
import type { CiTestTimings } from "./ci-test-timings-schema.mts";

export type CiTimingRun = {
  id: number;
  createdAt: string;
  logs: { kind: "uiE2e" | "compact"; text: string }[];
};

type Samples = Map<string, number[]>;

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function recordSample(samples: Samples, key: string, value: number) {
  if (Number.isFinite(value) && value > 0) {
    const values = samples.get(key) ?? [];
    values.push(value);
    samples.set(key, values);
  }
}

function seconds(value: string, unit: string): number {
  return Number(value) / (unit === "ms" ? 1000 : 1);
}

function readUiLog(text: string, samples: Samples, overhead: number[]) {
  let fileCount = 0;
  for (const line of text.split("\n")) {
    const file = /ui-e2e\s+(\S+\.e2e\.test\.ts)\s+\((\d+) tests?\)\s+([\d.]+)(m?s)/u.exec(line);
    if (file) {
      recordSample(samples, file[1]!, seconds(file[3]!, file[4]!));
      fileCount += 1;
    }
    const summary = /\bDuration\s+([\d.]+)(m?s)\s+\([^)]*\btests\s+([\d.]+)(m?s)/u.exec(line);
    if (summary && fileCount > 0) {
      const value =
        (seconds(summary[1]!, summary[2]!) - seconds(summary[3]!, summary[4]!)) / fileCount;
      if (Number.isFinite(value)) {
        overhead.push(value);
      }
      fileCount = 0;
    }
  }
}

function readCompactLog(text: string, samples: Samples) {
  const starts = new Map<string, number>();
  for (const line of text.split("\n")) {
    const event =
      /(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+.*?\[shard:([^\]]+)\] (begin|end \(exit (\d+)\))/u.exec(line);
    if (!event) {
      continue;
    }
    const timestamp = event[1]!;
    const key = event[2]!;
    const action = event[3]!;
    const exitCode = event[4];
    if (action === "begin") {
      starts.set(key, Date.parse(timestamp));
      continue;
    }
    const started = starts.get(key);
    if (exitCode === "0" && started !== undefined) {
      recordSample(samples, key, (Date.parse(timestamp) - started) / 1000);
    }
    starts.delete(key);
  }
}

function refitMap(samples: Samples, previous: Record<string, number> = {}) {
  const next = { ...previous };
  for (const [key, values] of samples) {
    const center = median(values);
    const retained = values.filter((value) => value <= center * 2.5);
    if (retained.length >= 2) {
      const measured = median(retained);
      if (
        previous[key] === undefined ||
        Math.abs(measured - previous[key]) > previous[key] * 0.15
      ) {
        next[key] = Math.max(1, Math.round(measured));
      }
    }
  }
  return Object.fromEntries(
    Object.entries(next).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export function refitTestTimings(runs: CiTimingRun[], previous?: CiTestTimings) {
  const samples = {
    uiE2e: new Map<string, number[]>(),
    blacksmith: new Map<string, number[]>(),
    github: new Map<string, number[]>(),
  };
  const overhead: number[] = [];
  for (const run of runs) {
    const current = {
      uiE2e: new Map<string, number[]>(),
      blacksmith: new Map<string, number[]>(),
      github: new Map<string, number[]>(),
    };
    for (const log of run.logs) {
      const text = stripVTControlCharacters(log.text);
      if (log.kind === "uiE2e") {
        readUiLog(text, current.uiE2e, overhead);
      } else {
        const profile = /\bBLACKSMITH_[A-Z0-9_]+\s*[:=]/u.test(text) ? "blacksmith" : "github";
        readCompactLog(text, current[profile]);
      }
    }
    // Retries or duplicate reporter lines in one run must not satisfy the two-run minimum.
    for (const profile of ["uiE2e", "blacksmith", "github"] as const) {
      for (const [key, values] of current[profile]) {
        recordSample(samples[profile], key, median(values));
      }
    }
  }

  const measuredOverhead =
    overhead.length >= 2 ? Math.max(0, Math.min(5, median(overhead))) : undefined;
  const oldOverhead = previous?.uiE2e.perFileOverheadSeconds;
  const keepOverhead =
    measuredOverhead === undefined ||
    (oldOverhead !== undefined && Math.abs(measuredOverhead - oldOverhead) <= oldOverhead * 0.15);
  const runIds = [...new Set(runs.map((run) => run.id))].toSorted((a, b) => a - b);
  const timings: CiTestTimings = {
    compactGroupSeconds: {
      blacksmith: refitMap(samples.blacksmith, previous?.compactGroupSeconds.blacksmith),
      github: refitMap(samples.github, previous?.compactGroupSeconds.github),
    },
    source: `median of ${runIds.length} successful main CI runs: ${runIds.join(", ")}`,
    uiE2e: {
      fileSeconds: refitMap(samples.uiE2e, previous?.uiE2e.fileSeconds),
      perFileOverheadSeconds: keepOverhead
        ? (oldOverhead ?? 0)
        : Math.round(measuredOverhead * 10) / 10,
    },
    updatedAt:
      runs
        .map((run) => run.createdAt.slice(0, 10))
        .toSorted()
        .at(-1) ??
      previous?.updatedAt ??
      new Date().toISOString().slice(0, 10),
    version: 1,
  };
  const changes: { key: string; old: number | undefined; next: number }[] = [];
  const comparedMaps: [string, Record<string, number>, Record<string, number> | undefined][] = [
    [
      "compactGroupSeconds.blacksmith",
      timings.compactGroupSeconds.blacksmith,
      previous?.compactGroupSeconds.blacksmith,
    ],
    [
      "compactGroupSeconds.github",
      timings.compactGroupSeconds.github,
      previous?.compactGroupSeconds.github,
    ],
    ["uiE2e.fileSeconds", timings.uiE2e.fileSeconds, previous?.uiE2e.fileSeconds],
    [
      "uiE2e",
      { perFileOverheadSeconds: timings.uiE2e.perFileOverheadSeconds },
      oldOverhead === undefined ? undefined : { perFileOverheadSeconds: oldOverhead },
    ],
  ];
  for (const [prefix, next, old] of comparedMaps) {
    for (const [key, value] of Object.entries(next)) {
      const oldValue = old?.[key];
      if (value !== oldValue) {
        changes.push({ key: `${prefix}.${key}`, old: oldValue, next: value });
      }
    }
  }
  if (previous && changes.length === 0) {
    timings.source = previous.source;
    timings.updatedAt = previous.updatedAt;
  }
  return {
    timings,
    changes: changes.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    runIds,
  };
}
