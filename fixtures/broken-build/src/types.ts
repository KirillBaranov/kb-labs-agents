export interface ReportSection {
  title: string;
  content: string;
  severity: 'info' | 'warning' | 'error';
}

export interface AgentReport {
  taskId: string;
  generatedAt: Date;
  sections: ReportSection[];
  summary: string;
}
