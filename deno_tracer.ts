import { parseArgs } from "jsr:@std/cli/parse-args";

const args = parseArgs(Deno.args);

if (args.help) {
  console.log("Usage: demon [options] <args>");
  console.log("Options:");
  console.log("  --help    Show this help message");
  console.log("  --stdout  Redirect stdout to a file");
  console.log("  --stderr  Redirect stderr to a file");
  Deno.exit(0);
}

const forward = args._ ?? [];

const cmd = new Deno.Command(Deno.execPath(), {
  args: ["--strace-ops", ...forward],
  stdout: "piped",
  stderr: "piped",
  stdin: "null",
});

const child = cmd.spawn();

const stdout = Deno.openSync(args.stdout ?? "stdout.log", {
  write: true,
  create: true,
});
const stderr = Deno.openSync(args.stderr ?? "stderr.log", {
  write: true,
  create: true,
});

const decoder = new TextDecoder();

//[    29.721] op_run_microtasks                                  : Completed Slow
//[    29.721] op_bootstrap_no_color                              : Dispatched Slow
//[    29.721] op_bootstrap_no_color                              : Completed Slow
//[    29.721] op_bootstrap_is_stdout_tty                         : Dispatched Slow
function parseStraceLine(log: string) {
  const timestampEnd = log.indexOf("]");
  if (timestampEnd === -1) {
    return;
  }

  const timestamp = log.slice(1, timestampEnd);
  const opStart = log.indexOf("op_", timestampEnd);
  if (opStart === -1) {
    return;
  }

  const opEnd = log.indexOf(":", opStart);
  const op = log.slice(opStart, opEnd).trim();
  if (op == undefined || op == "op_run_microtask") {
    return;
  }

  const status = log.slice(opEnd + 1).trim();
  if (status == undefined) {
    return;
  }

  const type = status.split(" ")[1];
  if (type != "Fast" && type != "Slow" && type != "Async") {
    return;
  }
  return {
    timestamp,
    op,
    completed: status.includes("Completed"),
    type,
  };
}

const logs = [];
function renderStraceAggregated() {
  const dispatchOps = new Map();
  const completedOps = new Map();
  const opTypes = new Map();

  for (const { op, completed, type } of logs) {
    if (completed) {
      completedOps.set(op, (completedOps.get(op) ?? 0) + 1);
    } else {
      dispatchOps.set(op, (dispatchOps.get(op) ?? 0) + 1);
      if (type == undefined) continue;
      opTypes.set(op, {
        fast: (opTypes.get(op)?.fast ?? 0) + (type == "Fast" ? 1 : 0),
        slow: (opTypes.get(op)?.slow ?? 0) + (type == "Slow" ? 1 : 0),
        async: (opTypes.get(op)?.async ?? 0) + (type == "Async" ? 1 : 0),
      });
    }
  }
  const table = [];
  for (const [op, count] of dispatchOps) {
    if (op == undefined) continue;
    const completed = completedOps.get(op) ?? 0;
    const pending = Math.max(0, count - completed);

    table.push({ op, count, completed, pending, ...opTypes.get(op) });
  }
  table.sort((a, b) => b.count - a.count);
  if (table.length == 0) return;

  console.clear();
  fastTableWithPadding(table);
}

function fastTableWithPadding(data: any[]) {
  const columns = Object.keys(data[0]);
  const columnWidths = columns.map((column) =>
    Math.max(
      column.length,
      ...data.map((row) => row[column]?.toString().length),
    )
  );

  const header = columns.map((column, i) => column.padEnd(columnWidths[i]))
    .join(
      " | ",
    );
    // bold
  console.log(`%c${header}`, "font-weight: bold");

  for (const row of data) {
    const line = columns.map((column, i) =>
      row[column]?.toString().padEnd(columnWidths[i])
    ).join(" | ");
    console.log(line);
  }
}

function writeStreamLog(stream: Deno.File, chunk: Uint8Array) {
  return new WritableStream({
    write(chunk) {
      const text = decoder.decode(chunk);
      const lines = text.split("\n");
      for (const line of lines) {
        logs.push(parseStraceLine(line) ?? {});
      }

      renderStraceAggregated();
      return stream.write(chunk);
    },
    close() {
      stream.close();
    },
    abort(e) {
      console.error(e);
      stream.close();
    },
  });
}

child.stdout.pipeTo(stdout.writable);
child.stderr.pipeTo(writeStreamLog(stderr));

const status = await child.status;
console.log(`Child process exited with status ${status.code}`);
