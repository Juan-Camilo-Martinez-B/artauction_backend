-- Pasa a la rotacion las salas programadas del catalogo de demostracion.
--
-- Al publicarse, cada obra recibe una sala SCHEDULED con horario aleatorio en
-- las proximas 48 horas, y la rotacion solo adelanta salas ROTATION. Si toda la
-- cartelera se publica de una vez, la rotacion no tiene de donde sacar y puede
-- haber ratos sin ninguna sala abierta. Con este cambio mantiene siempre
-- AUTO_AUCTION_SLOTS salas, y una sala que cierra sin pujas vuelve a entrar.
--
-- Solo toca salas sin abrir de las cuentas de la demostracion. Repetirlo no hace nada.
\set ON_ERROR_STOP on
UPDATE auction.auctions a
SET origin = 'ROTATION'
FROM identity.users u
WHERE u.id = a.seller_id
  AND u.email ~ '^(aurora|bellamy|norte|lumen|vertice)@'
  AND a.status = 'PROGRAMADA'
  AND a.origin = 'SCHEDULED';
