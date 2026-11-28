import { type Kysely, sql } from "kysely";

// TVDB numbers movies and series separately. A bare TVDB id is read as a series, so a movie's id
// must be stored as `movie:<id>`; TMDB sync used to store it bare. Rows whose prefixed form is
// already taken stay as they are (a duplicate media the merge flow resolves).
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    update associations a
    set native_id = 'movie:' || a.native_id, updated_at = now()
    from media m
    where a.media_id = m.id
      and m.type = 'movie'
      and a.namespace = 'tvdb'
      and a.is_external_id
      and a.native_id ~ '^[1-9][0-9]*$'
      and not exists (
        select 1 from associations b
        where b.namespace = 'tvdb'
          and b.native_id = 'movie:' || a.native_id
          and (b.is_external_id or b.media_id = a.media_id)
      )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    update associations a
    set native_id = substr(a.native_id, 7), updated_at = now()
    from media m
    where a.media_id = m.id
      and m.type = 'movie'
      and a.namespace = 'tvdb'
      and a.is_external_id
      and a.native_id ~ '^movie:[1-9][0-9]*$'
      and not exists (
        select 1 from associations b
        where b.namespace = 'tvdb'
          and b.native_id = substr(a.native_id, 7)
          and (b.is_external_id or b.media_id = a.media_id)
      )
  `.execute(db);
}
