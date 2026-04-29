CREATE TABLE players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    number TEXT,
    position TEXT,
    bats_throws TEXT,
    height TEXT,
    weight TEXT,
    photo_url TEXT,
    team_category TEXT NOT NULL -- 'u15', 'u17d1', 'u17d2'
);
