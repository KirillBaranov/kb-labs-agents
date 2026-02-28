import type { AgentReport, ReportSection } from './types.js';

export class ReportBuilder {
  private sections: ReportSection[] = [];

  constructor(private taskId: string) {}

  add(section: ReportSection): this {
    this.sections.push(section);
    return this;
  }

  build(): AgentReport {
    return {
      taskId: this.taskId,
      generatedAt: new Date(),
      sections: this.sections,
      summary: this.sections
        .filter(s => s.severity !== 'info')
        .map(s => s.title)
        .join(', ') || 'No issues found',
    };
  }

  toMarkdown(report: AgentReport): string {
    const lines = [
      `# Agent Report: ${report.taskId}`,
      `Generated: ${report.generatedAt.toISOString()}`,
      '',
      `## Summary`,
      report.summary,
      '',
    ];
    for (const section of report.sections) {
      lines.push(`## ${section.title} [${section.severity}]`);
      lines.push(section.content);
      lines.push('');
    }
    return lines.join('\n');
  }
}
