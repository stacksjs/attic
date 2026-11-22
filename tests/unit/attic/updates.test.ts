import { expect, test } from 'bun:test'
import { ATTIC_RELEASE_REPO, githubUpdateFetcher, manifestAsset, updateArchiveUrl } from '../../../app/Attic/updates'

const api = `https://api.github.com/repos/${ATTIC_RELEASE_REPO}/releases`

test('the private update feed gets the versioned manifest without forwarding credentials to the CDN', async () => {
  const calls: Array<{ url: string, authorization: string | null }> = []
  const cdn = 'https://release-assets.example.net/download'
  const fetcher = githubUpdateFetcher(async () => 'fixture-token', async (input, init) => {
    const url = String(input)
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') })
    if (url === `${api}/latest`)
      return Response.json({ assets: [{ name: manifestAsset(), id: 42 }] })
    if (url === `${api}/assets/42`)
      return Response.redirect(cdn)
    return Response.json({ version: '0.3.4' })
  })
  const response = await fetcher(`${api}/latest/darwin/${process.arch}?current=0.3.3`)
  expect(await response.json()).toEqual({ version: '0.3.4' })
  expect(calls).toEqual([
    { url: `${api}/latest`, authorization: 'Bearer fixture-token' },
    { url: `${api}/assets/42`, authorization: 'Bearer fixture-token' },
    { url: cdn, authorization: null },
  ])
})

test('the updater will only authenticate a download for this private repository', async () => {
  let credentialRead = false
  const fetcher = githubUpdateFetcher(async () => { credentialRead = true; return 'fixture-token' })
  const url = updateArchiveUrl('v0.3.4').replace(ATTIC_RELEASE_REPO, 'someone/else')
  await expect(fetcher(url)).rejects.toThrow('does not point to an Attic release')
  expect(credentialRead).toBe(false)
})
