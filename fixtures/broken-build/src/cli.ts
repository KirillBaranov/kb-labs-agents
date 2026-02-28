import { ReportBuilder } from './report-builder.js';
import { readTraceFile } from './trace-reader.js';

const taskId = process.argv[2];
if (!taskId) {
  console.error('Usage: agent-reporter <task-id>');
  process.exit(1);
}

const trace = await readTraceFile(taskId);
const report = new ReportBuilder(taskId)
  .add({ title: 'Iterations', content: `Total: ${trace.iterations}`, severity: 'info' })
  .add({ title: 'Cost', content: `$${trace.cost}`, severity: trace.cost > 0.1 ? 'warning' : 'info' })
  .build();

console.log(new ReportBuilder(taskId).toMarkdown(report));
