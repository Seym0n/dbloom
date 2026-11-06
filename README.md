<div align="center">

<img width="2560" height="1105" alt="DBLoom banner" src="https://github.com/user-attachments/assets/0db52b38-235f-4445-957c-ba127b65c9c1" />

<p>
  <a href="https://seym0n.github.io/dbloom/"><b>Website</b></a> ·
  <a href="https://seym0n.github.io/dbloom/docs/"><b>Docs</b></a> ·
  <a href="https://seym0n.github.io/dbloom/docs/quickstart/">Quickstart</a> ·
  <a href="https://seym0n.github.io/dbloom/docs/deploy/docker-compose/">Deploy</a> ·
  <a href="https://seym0n.github.io/dbloom/docs/guides/ai-assistant/">AI assistant</a> ·
  <a href="https://seym0n.github.io/dbloom/docs/concepts/security-model/">Security</a>
</p>

<p>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" />
  <img alt="TanStack" src="https://img.shields.io/badge/TanStack-Start-FF4154" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white" />
  <img alt="Spec-driven" src="https://img.shields.io/badge/built-spec--driven-8A2BE2" />
  <img alt="phpMyAdmin alternative" src="https://img.shields.io/badge/phpMyAdmin-alternative-F89C0E?logo=phpmyadmin&logoColor=white" />
</p>

</div>

DBLoom is a modern web-based database management system (DBMS), built on TanStack in TypeScript. It offers the same set of functionalities of a DBMS, such as phpMyAdmin or Adminer, in a refreshed layout with extensive security features.

## Motivation of DBLoom

I'm truly a long-term user of phpMyAdmin, but the recent CVE and the ever-growing concerns around PHP and phpMyAdmin motivated me to create a modern alternative, based on TanStack. 
Why TanStack? It provides end-to-end type safety from server functions to routes, and a client-first model with an explicit server boundary, without Next.js's RSC and caching complexity.
Finally, AI plays a greater role in our every day life, and DBLoom features an integrated AI assistant, capable of translating user requests into SQL commands, without the need of exposing the database to the public network.

## How DBLoom was built

DBLoom was built in nearly three weeks from scratch using AI-driven development.
Unlike common practice to just ask an AI to build a DBMS from scratch, DBLoom was built via spec-driven development, where specifications from an existimg legacy system (here: phpMyAdmin) were collected first via subagents.
Upon collecting these specifications, such specification may typically contain smells, be it a bug that is still unreported or a feature from a deprecated database version.
To tackle that, any open issues from phpMyAdmin were collected and checked against the specification whether they apply. Any relevant specification has been amended accordingly.
In the second wave, specifcations linked to older database versions that are deprecated by now were removed. In the other way, newer database versions may have received features that may not be present in the specifications, which has been accordingly considered.
Upon the specification rework, there were several large modules consisting of smaller tasks which have been developed accompanied each with unit and end-to-end testing.
