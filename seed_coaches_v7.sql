-- Seed initial 12 coaches from hardcoded COACHES const in coach.html (as of 2026-05-13).
-- Re-running this is safe (INSERT OR IGNORE).

-- 15U AAA
INSERT OR IGNORE INTO coaches (slug, name, number, role_fr, role_en, team) VALUES
  ('dave-dufour',             'Dave Dufour',             '10', 'Entraîneur-chef',   'Head Coach',      'u15'),
  ('mathieu-fontaine',        'Mathieu Fontaine',        '1',  'Entraîneur adjoint','Assistant Coach', 'u15'),
  ('jean-christophe-masson',  'Jean-Christophe Masson',  '22', 'Entraîneur adjoint','Assistant Coach', 'u15'),
  ('vincent-leveille',        'Vincent Léveillé',        '75', 'Entraîneur adjoint','Assistant Coach', 'u15');

-- 17U AAA D1
INSERT OR IGNORE INTO coaches (slug, name, number, role_fr, role_en, team) VALUES
  ('jonathan-landry',         'Jonathan Landry',         '12', 'Entraîneur-chef',   'Head Coach',      'u17d1'),
  ('jean-pierre-chamberland', 'Jean-Pierre Chamberland', '71', 'Entraîneur adjoint','Assistant Coach', 'u17d1'),
  ('mathieu-vachon',          'Mathieu Vachon',          '6',  'Entraîneur adjoint','Assistant Coach', 'u17d1'),
  ('loic-masse',              'Loïc Massé',              '8',  'Entraîneur adjoint','Assistant Coach', 'u17d1');

-- 17U AAA D2
INSERT OR IGNORE INTO coaches (slug, name, number, role_fr, role_en, team) VALUES
  ('mathieu-deschenes',       'Mathieu Deschênes',       '15', 'Entraîneur-chef',   'Head Coach',      'u17d2'),
  ('arthur-perrois',          'Arthur Perrois',          '16', 'Entraîneur adjoint','Assistant Coach', 'u17d2'),
  ('laurent-savard',          'Laurent Savard',          '55', 'Entraîneur adjoint','Assistant Coach', 'u17d2'),
  ('francis-verge',           'Francis Verge',           '23', 'Entraîneur adjoint','Assistant Coach', 'u17d2');
