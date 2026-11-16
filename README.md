# @socialscrape/ai-sdk

SocialScrape tools for the [Vercel AI SDK](https://ai-sdk.dev). Give a model one key and nine tools that return social media data in one JSON shape: profiles, posts, comments, search and video transcripts across 29 platforms.

- One import, one key: `socialscrapeTools()`.
- Compact answers sized for a model: long lists are trimmed, cursors are kept for paging.
- Long transcripts wait for the transcription job to finish.
- Errors come back as a message the model can read, with SocialScrape's error code and whether anything was billed. Failed requests are free.
- Works with `ai` 6 and 7, `zod` 4. Built on the [`socialscrape`](https://www.npmjs.com/package/socialscrape) client, so retries and timeouts are handled.

## Install

```sh
npm install @socialscrape/ai-sdk ai zod
```

Create an API key in the [dashboard](https://socialscrape.dev/app) (a new account starts with free credits), then set it:

```sh
export SOCIALSCRAPE_API_KEY="ss_live_..."
```

Server-side only: the key is a secret, so keep it out of code that ships to a browser.

## Use

```ts
import { generateText, isStepCount } from 'ai';
import { socialscrapeTools } from '@socialscrape/ai-sdk';

const { text } = await generateText({
  model: 'openai/gpt-5-mini',
  prompt: 'What did NASA post on YouTube this week, and what are people saying in the comments?',
  tools: socialscrapeTools(),
  stopWhen: isStepCount(5),
});

console.log(text);
```

The platform is an argument the model fills in, for example `{ platform: "tiktok", handle: "nasa" }`. For a post, its comments or a transcript, the platform is read from the link.

## Tools

| Tool | What it does | Credits |
|---|---|---|
| `getProfile` | A profile, channel or artist: name, bio, links, verification, follower counts. 17 platforms. | 1 |
| `getPosts` | The latest posts or videos of a profile, channel or page, one page per call. 14 platforms. | 1 per page |
| `getPost` | One post, video, tweet, pin or clip from its URL. 18 platforms. | 1 |
| `getComments` | The comments on a post or video, one page per call. 7 platforms. | 1 per page |
| `getTranscript` | The transcript of a video from its URL, from captions or AI transcription. | 1 with captions; AI transcription 1 up to 2 minutes, then 5 per started minute of the whole video |
| `search` | Keyword search on one platform, one page per call. 14 platforms. | 1 per page |
| `listEndpoints` | Every endpoint id with its parameters and price. Makes no request. | Free |
| `callEndpoint` | Runs any endpoint in the [API reference](https://socialscrape.dev/docs/api) by its id. Parameters are checked first. | Most 1; see the endpoint |
| `getCredits` | The credit balance of the account. | Free |

A request that fails costs nothing. A cached answer (see `maxAgeDays`) costs 0 credits. Full rules: [credits](https://socialscrape.dev/docs/credits).

Tools that list things return `cursor` and `has_more` in `data`; the model passes the cursor back for the next page.

## Options

```ts
socialscrapeTools({
  apiKey: process.env.SOCIALSCRAPE_API_KEY, // default
  baseUrl: 'https://api.socialscrape.dev',  // default
  include: ['getProfile', 'getTranscript', 'search'], // default: all
  maxAgeDays: 7,
  maxResponseChars: 40_000,
  maxTranscriptChars: 60_000,
});
```

| Option | What it does |
|---|---|
| `apiKey` | The API key. Default: `process.env.SOCIALSCRAPE_API_KEY`. |
| `baseUrl` | API base URL. |
| `include` | Return only these tools. Names: `getProfile`, `getPosts`, `getPost`, `getComments`, `getTranscript`, `search`, `listEndpoints`, `callEndpoint`, `getCredits`. |
| `maxAgeDays` | Accept a cached answer up to this many days old (0 to 30). A cached answer costs 0 credits. |
| `trim` | On by default: asks for the smaller response, without null fields and the `extra` object. |
| `maxResponseChars` | Most characters of JSON per answer. A list page loses items from its end and says so in `truncated`; the cursor stays. Default 40000. |
| `maxTranscriptChars` | Most characters of transcript text returned. Default 60000. |
| `client` | A `SocialScrape` client you configured yourself. |
| `clientOptions` | Timeouts, retries or your own `fetch` for the client the tools make. |

Each tool factory is also exported on its own, for example `getProfile(options)` and `getTranscript(options)`.

## Answers and errors

A tool answers with an object, never a thrown error:

```json
{ "ok": true, "data": { "...": "..." }, "credits_charged": 1, "credits_remaining": 49 }
```

```json
{
  "ok": false,
  "error": { "code": "not_found", "message": "...", "retryable": false, "request_id": "req_..." },
  "billed": false,
  "credits_charged": 0
}
```

`error.code` is SocialScrape's [error code](https://socialscrape.dev/docs/errors). Parameters the model got wrong (a platform that does not fit the identifier, an unknown parameter name) answer `invalid_params` before any request is made. A missing key answers `missing_api_key` when a tool runs, so setting up the tools never throws. A transcription that outlives the wait answers `job_timeout` with a `job_id`; nothing is billed for that call.

## Links

- Website: https://socialscrape.dev
- Guide: https://socialscrape.dev/docs/ai-sdk
- API reference: https://socialscrape.dev/docs/api
- TypeScript client: https://www.npmjs.com/package/socialscrape

## License

MIT
