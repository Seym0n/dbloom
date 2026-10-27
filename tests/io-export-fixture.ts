/** Fixture of the export tests (FR-IO-027): every column type, hostile text, a foreign-key cycle, views, routines, a trigger, an event. */
import type { Pool } from 'mysql2/promise'

export async function createFixture(pool: Pool, db: string, product: 'mysql' | 'mariadb', bulk = 100_000): Promise<void> {
  await pool.query(`DROP DATABASE IF EXISTS ${db}`)
  await pool.query(`CREATE DATABASE ${db} DEFAULT CHARACTER SET utf8mb4`)
  const c = await pool.getConnection()
  try {
    await c.query(`USE ${db}`)
    await c.query(`CREATE TABLE types_t (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      t_tiny TINYINT UNSIGNED, t_big BIGINT, t_bigu BIGINT UNSIGNED, t_dec DECIMAL(20,6), t_float FLOAT, t_double DOUBLE,
      t_bit BIT(12), t_year YEAR, t_date DATE, t_time TIME(3), t_dt DATETIME(6), t_ts TIMESTAMP NULL,
      t_char CHAR(8), t_vc VARCHAR(200) CHARACTER SET utf8mb4, t_text TEXT, t_enum ENUM('a','b c','d''e'), t_set SET('x','y','z'),
      t_bin BINARY(4), t_vbin VARBINARY(100), t_blob BLOB, t_json JSON, t_geo POINT,
      g_val INT GENERATED ALWAYS AS (t_tiny * 2) VIRTUAL,
      KEY k_vc (t_vc(20))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    await c.query(
      `INSERT INTO types_t (t_tiny, t_big, t_bigu, t_dec, t_float, t_double, t_bit, t_year, t_date, t_time, t_dt, t_ts, t_char, t_vc, t_text,
         t_enum, t_set, t_bin, t_vbin, t_blob, t_json, t_geo) VALUES
       (7, 9007199254740993, 18446744073709551615, 12345678901234.123456, 3.14159274, 0.30000000000000004, b'101010101010', 2024, '2026-10-27',
        '-12:34:56.789', '2026-10-27 12:34:56.123456', '2026-10-27 12:34:56', 'ab', 'quote '' backslash \\\\ nul \\0 cr \\r lf \\n tab \\t "dq" 日本語 😀',
        'Zeile1\\nZeile2; DROP TABLE x; --', 'd''e', 'x,z', 0x00ff10aa, 0x00, 0xDEADBEEF, '{"a": [1, 2, {"b": null}], "ü": "ß"}', ST_GeomFromText('POINT(1 2)')),
       (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
       (255, -9223372036854775808, 0, -0.000001, -1.5e-30, 1e300, b'0', 1901, '1000-01-01', '838:59:59', '1000-01-01 00:00:00.000000', '2038-01-19 03:14:07',
        '', '', '', 'a', '', 0x00000000, '', '', '[]', ST_GeomFromText('POINT(-1.5 2.25)'))`,
    )
    // parent comes after its child by name: the dump must write the parent first
    await c.query('CREATE TABLE z_parent (id INT PRIMARY KEY, name VARCHAR(30)) ENGINE=InnoDB')
    await c.query('CREATE TABLE a_child (id INT PRIMARY KEY, pid INT NOT NULL, CONSTRAINT fk_child FOREIGN KEY (pid) REFERENCES z_parent (id) ON DELETE CASCADE) ENGINE=InnoDB')
    await c.query("INSERT INTO z_parent VALUES (1, 'one'), (2, 'zwei')")
    await c.query('INSERT INTO a_child VALUES (10, 1), (11, 2), (12, 2)')
    // foreign-key cycle
    await c.query('CREATE TABLE cyc_a (id INT PRIMARY KEY, b_id INT NULL) ENGINE=InnoDB')
    await c.query('CREATE TABLE cyc_b (id INT PRIMARY KEY, a_id INT NULL) ENGINE=InnoDB')
    await c.query('INSERT INTO cyc_a VALUES (1, NULL), (2, NULL)')
    await c.query('INSERT INTO cyc_b VALUES (1, 1), (2, 2)')
    await c.query('UPDATE cyc_a SET b_id = id')
    await c.query('ALTER TABLE cyc_a ADD CONSTRAINT fk_a_b FOREIGN KEY (b_id) REFERENCES cyc_b (id)')
    await c.query('ALTER TABLE cyc_b ADD CONSTRAINT fk_b_a FOREIGN KEY (a_id) REFERENCES cyc_a (id)')
    // views: the top view sorts first by name but depends on the base view
    await c.query('CREATE VIEW b_view_base AS SELECT id, t_vc FROM types_t')
    await c.query('CREATE VIEW a_view_top AS SELECT id FROM b_view_base WHERE id > 0')
    // data of the trigger table and the trigger that would change it
    await c.query('CREATE TABLE bulk (id INT PRIMARY KEY, v VARCHAR(40), n DECIMAL(10,2)) ENGINE=InnoDB')
    await c.query('CREATE TABLE d (i INT)')
    await c.query('INSERT INTO d VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)')
    if (bulk > 0) {
      const rows = bulk
      await c.query(
        `INSERT INTO bulk SELECT id, CONCAT('row-', id), id / 7 FROM (SELECT a.i + b.i * 10 + c.i * 100 + e.i * 1000 + f.i * 10000 + 1 AS id
           FROM d a, d b, d c, d e, d f) x WHERE id <= ${rows}`,
      )
    }
    await c.query('DROP TABLE d')
    await c.query('ANALYZE TABLE bulk')
    await c.query("CREATE TRIGGER trg_bulk_ins BEFORE INSERT ON bulk FOR EACH ROW SET NEW.v = CONCAT('t-', NEW.v)")
    await c.query('CREATE FUNCTION fn_add(a INT, b INT) RETURNS INT DETERMINISTIC RETURN a + b')
    await c.query('CREATE PROCEDURE p_hello() BEGIN SELECT 1; SELECT 2; END')
    await c.query('CREATE EVENT ev_x ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1')
    void product
  } finally {
    c.release()
  }
}
