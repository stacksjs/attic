/**
 * Slack and Discord tokens, kept in the login keychain rather than in Attic's
 * database: they are credentials to someone's whole account, and the
 * keychain is where macOS keeps those.
 */

const SERVICE = 'com.stacksjs.attic'

export async function readSecret(account: string): Promise<string | null> {
  const run = Bun.spawn(['/usr/bin/security', 'find-generic-password', '-s', SERVICE, '-a', account, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited])
  return code === 0 ? out.trim() || null : null
}

/** Quoted for `security -i`'s own command parser. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export async function writeSecret(account: string, secret: string): Promise<boolean> {
  // Through `security -i` on stdin rather than argv, where any process on the
  // Mac could read the token for as long as the command ran. -U updates an
  // existing item instead of failing on it.
  const run = Bun.spawn(['/usr/bin/security', '-i'], { stdio: ['pipe', 'ignore', 'pipe'] })
  run.stdin.write(`add-generic-password -U -s ${quote(SERVICE)} -a ${quote(account)} -w ${quote(secret)}\n`)
  await run.stdin.end()
  const [errors, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  return code === 0 && !errors.trim()
}

export async function deleteSecret(account: string): Promise<void> {
  await Bun.spawn(['/usr/bin/security', 'delete-generic-password', '-s', SERVICE, '-a', account], { stdio: ['ignore', 'ignore', 'ignore'] }).exited
}
