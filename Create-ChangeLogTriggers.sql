-- kantech_change_log: audit table for cardholder/access level changes
-- Triggers fire on INSERT/UPDATE/DELETE of kantech_cards
-- "future function" hook: add logic to on_kantech_change() procedure below

CREATE TABLE IF NOT EXISTS kantech_change_log (
    ChangeID        BIGINT       NOT NULL AUTO_INCREMENT,
    ChangedAt       DATETIME     NOT NULL DEFAULT NOW(),
    ChangeType      VARCHAR(10)  NOT NULL,          -- INSERT / UPDATE / DELETE
    CardholderID    INT          NULL,
    CardNumber      VARCHAR(50)  NOT NULL DEFAULT '',
    FullName        VARCHAR(255) NOT NULL DEFAULT '',
    AccessLevel     VARCHAR(255) NOT NULL DEFAULT '',
    ProcessedAt     DATETIME     NULL,              -- set when future function runs
    PRIMARY KEY (ChangeID),
    KEY idx_processed (ProcessedAt),
    KEY idx_changed   (ChangedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------
-- Stub procedure — replace body with real logic later
-- --------------------------------------------------------
DROP PROCEDURE IF EXISTS on_kantech_change;

DELIMITER $$
CREATE PROCEDURE on_kantech_change(
    IN p_change_id  BIGINT,
    IN p_type       VARCHAR(10),
    IN p_id         INT,
    IN p_name       VARCHAR(255)
)
BEGIN
    -- TODO: implement future function here
    -- e.g. call an external API, update another table, send notification
    UPDATE kantech_change_log SET ProcessedAt = NOW() WHERE ChangeID = p_change_id;
END$$
DELIMITER ;

-- --------------------------------------------------------
-- Triggers on kantech_cards
-- --------------------------------------------------------
DROP TRIGGER IF EXISTS trg_kantech_cards_insert;
DROP TRIGGER IF EXISTS trg_kantech_cards_update;
DROP TRIGGER IF EXISTS trg_kantech_cards_delete;

DELIMITER $$

CREATE TRIGGER trg_kantech_cards_insert
AFTER INSERT ON kantech_cards
FOR EACH ROW
BEGIN
    DECLARE v_id BIGINT;
    INSERT INTO kantech_change_log (ChangeType, CardholderID, CardNumber, FullName, AccessLevel)
    VALUES ('INSERT', NEW.CardholderID, NEW.CardNumberFormatted, NEW.FullName, NEW.AccessLevel);
    SET v_id = LAST_INSERT_ID();
    CALL on_kantech_change(v_id, 'INSERT', NEW.CardholderID, NEW.FullName);
END$$

CREATE TRIGGER trg_kantech_cards_update
AFTER UPDATE ON kantech_cards
FOR EACH ROW
BEGIN
    DECLARE v_id BIGINT;
    -- Only log if something meaningful changed
    IF OLD.FullName <> NEW.FullName
    OR OLD.AccessLevel <> NEW.AccessLevel
    OR OLD.CardNumberFormatted <> NEW.CardNumberFormatted
    OR COALESCE(OLD.IsActive,'') <> COALESCE(NEW.IsActive,'')
    THEN
        INSERT INTO kantech_change_log (ChangeType, CardholderID, CardNumber, FullName, AccessLevel)
        VALUES ('UPDATE', NEW.CardholderID, NEW.CardNumberFormatted, NEW.FullName, NEW.AccessLevel);
        SET v_id = LAST_INSERT_ID();
        CALL on_kantech_change(v_id, 'UPDATE', NEW.CardholderID, NEW.FullName);
    END IF;
END$$

CREATE TRIGGER trg_kantech_cards_delete
AFTER DELETE ON kantech_cards
FOR EACH ROW
BEGIN
    DECLARE v_id BIGINT;
    INSERT INTO kantech_change_log (ChangeType, CardholderID, CardNumber, FullName, AccessLevel)
    VALUES ('DELETE', OLD.CardholderID, OLD.CardNumberFormatted, OLD.FullName, OLD.AccessLevel);
    SET v_id = LAST_INSERT_ID();
    CALL on_kantech_change(v_id, 'DELETE', OLD.CardholderID, OLD.FullName);
END$$

DELIMITER ;
