import { reportSource } from './report-viewer.component';

describe('reportSource', () => {
  it('defaults to report.json next to the page', () => {
    expect(reportSource('', 'http://127.0.0.1:4317/report').toString()).toBe('http://127.0.0.1:4317/report.json');
  });

  it('follows ?src=, relative to the page', () => {
    expect(reportSource('?src=/report-data/report.json', 'http://127.0.0.1:4317/report').toString()).toBe(
      'http://127.0.0.1:4317/report-data/report.json',
    );
  });
});
