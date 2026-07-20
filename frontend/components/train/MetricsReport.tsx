import type { EvalMetrics } from "@/lib/types";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function MetricsReport({
  title,
  metrics,
  note,
}: {
  title: string;
  metrics: EvalMetrics;
  /** Optional caption shown under the header — used to disclose which
   * classes got a per-class CNN-only override on the "Combined" report. */
  note?: string | null;
}) {
  const classNames = Object.keys(metrics.per_class);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h4 className="text-base font-semibold text-text">{title}</h4>
        <p className="font-mono text-sm text-neutral-500">
          test accuracy <span className="font-semibold text-text">{pct(metrics.accuracy)}</span> ·{" "}
          {metrics.test_set_size} test images
        </p>
      </div>
      {note && <p className="mt-0.5 text-sm text-neutral-500">{note}</p>}

      <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-50 text-neutral-500">
            <tr>
              <th className="px-3 py-2 font-medium">Class</th>
              <th className="px-3 py-2 font-medium">Precision</th>
              <th className="px-3 py-2 font-medium">Recall</th>
              <th className="px-3 py-2 font-medium">F1</th>
              <th className="px-3 py-2 font-medium">Support</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {classNames.map((name) => {
              const m = metrics.per_class[name];
              return (
                <tr key={name}>
                  <td className="px-3 py-2 font-medium text-text">{name}</td>
                  <td className="px-3 py-2 font-mono">{pct(m.precision)}</td>
                  <td className="px-3 py-2 font-mono">{pct(m.recall)}</td>
                  <td className="px-3 py-2 font-mono">{pct(m.f1)}</td>
                  <td className="px-3 py-2 font-mono">{m.support}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium text-primary">Confusion matrix</summary>
        <div className="mt-2 overflow-x-auto rounded-lg border border-neutral-200">
          <table className="text-center text-sm">
            <thead className="bg-neutral-50 text-neutral-500">
              <tr>
                <th className="px-3 py-2 font-medium">actual \ predicted</th>
                {classNames.map((n) => (
                  <th key={n} className="px-3 py-2 font-medium">
                    {n}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {metrics.confusion_matrix.map((row, i) => (
                <tr key={classNames[i]}>
                  <td className="px-3 py-2 text-left font-medium text-text">{classNames[i]}</td>
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={`px-3 py-2 font-mono ${i === j ? "bg-success-tint text-success font-semibold" : ""}`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
