import Link from 'next/link'
import { AssistantPanel } from '../../components/assistant-panel'
import { HeroDemo } from '../../components/hero-demo'
import { SqlDemo } from '../../components/sql-demo'
import { Reveal } from '../../components/reveal'

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

const STEPS = [
  {
    clause: ['First the image starts.', 'One container, no proxy inside.'],
    env: ['image: dbloom', 'volume: /data', '(no variables needed)'],
    state: 'waiting for an address',
  },
  {
    clause: ['Then it learns its address.', 'Pin your domain, if you like.'],
    env: ['DBLOOM_PUBLIC_ORIGIN=https://db.example.com', '# optional, recommended'],
    state: 'answering on https',
  },
  {
    clause: ['Then it gets a key.', 'For second factors and recovery codes.'],
    env: [
      'DBLOOM_PUBLIC_ORIGIN=https://db.example.com',
      'DBLOOM_LOGIN_MODE=account',
      'DBLOOM_SECRET_KEY=•••••••••••',
    ],
    state: 'account mode ready',
  },
  {
    clause: ['Then you sign in.', 'The first visit runs the setup.'],
    env: ['setup-token', 'k7q2-m9xd-41ra'],
    state: 'connected to shop',
  },
] as const

export default function Home() {
  return (
    <main className="lp">
      <section
        className="hero"
        style={{ ['--hero-bg' as string]: `url(${BASE}/hero-bg.webp)` }}
      >
        <header className="bar">
          <Link href="/" className="word">
            DBLoom
          </Link>
          <nav aria-label="Main">
            <Link href="/docs">Docs</Link>
            <Link href="/docs/deploy/coolify">Deploy</Link>
            <a href="https://github.com/Seym0n/dbloom">GitHub</a>
            <Link href="/docs/setup" className="btn btn-sm">
              Make your .env
            </Link>
          </nav>
        </header>

        <div className="hero-text">
          <h1>
            <span className="mask">
              <span>MySQL and MariaDB,</span>
            </span>
            <span className="mask">
              <span>in your browser.</span>
            </span>
          </h1>
          <p className="lead rise">
            Browse and edit rows, change table structure, run SQL and import or export your data.
            An optional assistant writes the queries and waits for your approval.
          </p>
          <div className="cta-row rise">
            <Link href="/docs/setup" className="btn">
              Set it up in minutes
            </Link>
            <Link href="/docs" className="link">
              Read the docs
            </Link>
          </div>
        </div>

        <HeroDemo />
      </section>

      <section className="features" aria-labelledby="f-h">
        <Reveal as="h2" id="f-h" className="f-head">
          Ask, read, approve.
        </Reveal>
        <Reveal className="f-sub">
          <p>
            The assistant sidebar writes SQL for the connection you are using, then waits. It is off
            until an administrator connects a service, and it runs on your rights, not its own.
          </p>
        </Reveal>
        <AssistantPanel />
        <Reveal className="f-more">
          <h3>And the rest of a database admin</h3>
          <p>
            Browse, edit and search rows. Change table structure. Run SQL in tabs with history.
            Import and export SQL, CSV and JSON. Roles, second factors and passkeys when you want
            accounts, or plain database credentials when you do not.
          </p>
          <Link href="/docs" className="link">
            See how it works
          </Link>
        </Reveal>
      </section>

      <section className="sqld" aria-labelledby="b-h">
        <Reveal className="sqld-text">
          <h2 id="b-h">SQL in, rows out.</h2>
          <p>
            Pick a statement and watch it run: a query fills the grid, an update lights up the
            changed cell, an ALTER adds a column. Try it here, then on your own data.
          </p>
        </Reveal>
        <Reveal className="sqld-demo">
          <SqlDemo />
        </Reveal>
      </section>

      <section className="steps" aria-labelledby="s-h">
        <h2 id="s-h" className="s-head">
          Four steps to running.
        </h2>
        {STEPS.map((s, i) => (
          <div key={i} className={`field field-${i + 1}`}>
            <Reveal className="s-clause">
              <p>{s.clause[0]}</p>
              <p>{s.clause[1]}</p>
            </Reveal>
            <Reveal className="card-wrap">
              <div className="card" data-ui>
                <pre>
                  <code>{s.env.join('\n')}</code>
                </pre>
                <div className="card-state">{s.state}</div>
              </div>
            </Reveal>
          </div>
        ))}
      </section>

      <section className="close" aria-labelledby="c-h">
        <Reveal className="close-in">
          <h2 id="c-h" className="close-line">
            Build your .env in the setup guide, then deploy it on Coolify or any Docker host.
          </h2>
          <div className="cta-row">
            <Link href="/docs/setup" className="btn btn-sm">
              Open the setup guide
            </Link>
            <Link href="/docs/deploy/other-platforms" className="link">
              Other platforms
            </Link>
          </div>
        </Reveal>
      </section>

      <footer className="foot">
        <span className="soft">Self-hosted MySQL and MariaDB admin</span>
        <nav aria-label="Footer">
          <Link href="/docs">Docs</Link>
          <Link href="/docs/reference/environment">Variables</Link>
          <a href="https://github.com/Seym0n/dbloom">GitHub</a>
        </nav>
        <span className="soft end">2026</span>
      </footer>
    </main>
  )
}
