// Notification : sortie standard.
export async function notifyConsole(report) {
  process.stdout.write(`${report.text}\n`);
  return { canal: 'console', ok: true };
}
