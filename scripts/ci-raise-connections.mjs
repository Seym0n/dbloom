// CI only: the e2e server keeps a pool per live session and the whole suite exceeds the default of 151 connections.
// compose.test.yaml passes --max-connections=600 to mysqld; GitHub service containers cannot take command arguments,
// so the limit is raised at runtime on both servers.
import mysql from 'mysql2/promise'

for (const port of [33064, 33061]) {
  const conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'root' })
  await conn.query('SET GLOBAL max_connections = 600')
  const [rows] = await conn.query("SHOW VARIABLES LIKE 'max_connections'")
  console.log(port, rows)
  await conn.end()
}
