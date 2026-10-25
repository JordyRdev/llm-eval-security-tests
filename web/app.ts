// Browser client. Everything from the server is inserted with textContent, never innerHTML,
// so text from the model or the database cannot become markup (LLM10:2026).

interface AskResponse {
  answer: string;
  value: number | string | null;
  unit: string | null;
  sql: string | null;
  rows_used: Record<string, unknown>[];
  refused: boolean;
  reason?: string;
  meta: { role: string; provider: string; model: string; calls: number; latencyMs: number };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function rowsTable(rows: Record<string, unknown>[]): HTMLTableElement {
  const table = el("table");
  const columns = Object.keys(rows[0] ?? {});
  const head = table.createTHead().insertRow();
  for (const column of columns) head.appendChild(el("th", column));
  const body = table.createTBody();
  for (const row of rows.slice(0, 10)) {
    const tr = body.insertRow();
    for (const column of columns) tr.insertCell().textContent = cellText(row[column]);
  }
  return table;
}

function render(question: string, data: AskResponse): HTMLLIElement {
  const item = el("li", undefined, data.refused ? "answer refused" : "answer");
  item.dataset["testid"] = "answer";
  item.appendChild(el("p", question, "question"));
  const answer = el("p", data.answer);
  answer.dataset["testid"] = "answer-text";
  item.appendChild(answer);
  if (data.refused && data.reason) item.appendChild(el("p", `Refused: ${data.reason}`, "meta"));
  if (data.sql) {
    const details = el("details");
    details.appendChild(el("summary", "SQL and rows"));
    details.appendChild(el("pre", data.sql));
    if (data.rows_used.length > 0) details.appendChild(rowsTable(data.rows_used));
    item.appendChild(details);
  }
  item.appendChild(
    el(
      "p",
      `${data.meta.role} · ${data.meta.provider} ${data.meta.model} · ${String(data.meta.calls)} calls · ${String(data.meta.latencyMs)} ms`,
      "meta",
    ),
  );
  return item;
}

async function init(): Promise<void> {
  const form = byId("ask-form") as HTMLFormElement;
  const role = byId("role") as HTMLSelectElement;
  const questionInput = byId("question") as HTMLTextAreaElement;
  const status = byId("status") as HTMLParagraphElement;
  const answers = byId("answers") as HTMLOListElement;

  const roles = (await (await fetch("/api/roles")).json()) as { id: string; name: string }[];
  for (const r of roles) {
    const option = el("option", `${r.name} (${r.id})`);
    option.value = r.id;
    role.appendChild(option);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = questionInput.value;
    status.textContent = "Thinking…";
    void fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: role.value, question }),
    })
      .then(async (response) => {
        const data = (await response.json()) as AskResponse | { error: string };
        if ("error" in data) throw new Error(data.error);
        answers.prepend(render(question, data));
        status.textContent = "";
      })
      .catch((error: unknown) => {
        status.textContent = error instanceof Error ? error.message : String(error);
      });
  });
}

void init();
