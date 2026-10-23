import { createConnection } from 'mysql2/promise'

/** Seeds the MySQL 8.4 test container with a small shop. */
export default async function globalSetup() {
  const conn = await createConnection({
    host: '127.0.0.1',
    port: 33064,
    user: 'root',
    password: 'root',
  })
  await conn.query('DROP DATABASE IF EXISTS e2e_shop')
  await conn.query('CREATE DATABASE e2e_shop CHARACTER SET utf8mb4')
  await conn.query(
    `CREATE TABLE e2e_shop.orders (
       id INT PRIMARY KEY, customer VARCHAR(40) NOT NULL, amount DECIMAL(10,2) NOT NULL,
       placed_at DATETIME NOT NULL, note TEXT NULL, receipt BLOB NULL)`,
  )
  const rows: unknown[][] = []
  for (let i = 1; i <= 120; i++) {
    rows.push([
      i,
      i === 7 ? '<script>alert(1)</script>' : `Customer ${String(i).padStart(3, '0')}`,
      (i * 7.35).toFixed(2),
      `2026-10-${String((i % 28) + 1).padStart(2, '0')} 09:${String(i % 60).padStart(2, '0')}:00`,
      i % 5 === 0 ? null : `Order note ${i}`,
      i === 3 ? Buffer.from('deadbeef', 'hex') : null,
    ])
  }
  await conn.query('INSERT INTO e2e_shop.orders VALUES ?', [rows])
  await conn.query('CREATE TABLE e2e_shop.empty_table (id INT)')
  await conn.end()
}
