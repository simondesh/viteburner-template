import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseBoard,
    groupAt,
    playStone,
    secureTerritoryMask,
    orderedMoves,
    evaluateBoard,
    selectMove,
    type Grid,
} from '../src/utils/go-engine.ts';

const allValid = (grid: Grid): boolean[][] => grid.map((row) => row.map(() => true));

// An X wall fully enclosing a 5x5 interior, with one lone O reduction stone in
// the middle. The interior empties are morally X's territory/eye space, but
// because they touch the O stone the region borders {X,O}. This is the shape
// where the bot wrongly fills its own blank points.
const ENCLOSED = [
    'XXXXXXX',
    'X.....X',
    'X.....X',
    'X..O..X',
    'X.....X',
    'X.....X',
    'XXXXXXX',
];

// ---------------------------------------------------------------------------
// Characterization tests — these document behavior that must be preserved.
// ---------------------------------------------------------------------------

test('groupAt counts a connected group and its liberties', () => {
    const grid = parseBoard(['XX.', '...', '...']);
    const g = groupAt(grid, 0, 0);
    assert.equal(g.cells.length, 2);
    assert.equal(g.liberties, 3); // (1,0), (0,2), (1,1)
});

test('playStone captures an enemy group reduced to zero liberties', () => {
    const grid = parseBoard(['.X.', 'XO.', '.X.']);
    const played = playStone(grid, 1, 2, 'X'); // fills O's last liberty
    assert.ok(played);
    assert.equal(played!.captured, 1);
    assert.equal(played!.grid[1][1], '.'); // O removed
});

test('playStone rejects suicide', () => {
    const grid = parseBoard(['.O.', 'O.O', '.O.']);
    assert.equal(playStone(grid, 1, 1, 'X'), null);
});

test('secureTerritoryMask marks a fully enclosed single-colour region', () => {
    const grid = parseBoard(['XXXXX', 'X...X', 'X...X', 'X...X', 'XXXXX']);
    const mask = secureTerritoryMask(grid, 'X');
    assert.equal(mask[2][2], true);
    assert.equal(mask[1][1], true);
    assert.equal(mask[0][0], false); // a stone, not territory
});

test('evaluateBoard credits sealed territory to its owner', () => {
    const grid = parseBoard(['XXXXX', 'X...X', 'X...X', 'X...X', 'XXXXX']);
    assert.ok(evaluateBoard(grid) > 0); // X stones + 9 enclosed points
});

test('orderedMoves surfaces a capture as the top candidate', () => {
    const grid = parseBoard(['.X.', 'XO.', '.X.']);
    const moves = orderedMoves(grid, 'X');
    assert.ok(moves.length > 0);
    assert.equal(moves[0].x, 1);
    assert.equal(moves[0].y, 2); // capturing move ranked first
});

// ---------------------------------------------------------------------------
// Bug tests — the bot must keep blank points inside its own territory.
// ---------------------------------------------------------------------------

test('filling our own enclosed territory is not net-positive', () => {
    const before = parseBoard(ENCLOSED);
    const played = playStone(before, 1, 1, 'X'); // deep interior, far from the O
    assert.ok(played);
    const beforeValue = evaluateBoard(before);
    const afterValue = evaluateBoard(played!.grid);
    assert.ok(
        afterValue < beforeValue,
        `filling own territory should shed value: before=${beforeValue} after=${afterValue}`,
    );
});

test('orderedMoves does not offer a deep self-fill of our own territory', () => {
    const grid = parseBoard(ENCLOSED);
    const moves = orderedMoves(grid, 'X');
    const offersDeepFill = moves.some((m) => m.x === 1 && m.y === 1);
    assert.equal(offersDeepFill, false, 'deep interior point (1,1) must be kept blank');
});

test('orderedMoves still offers moves that contact the invader', () => {
    const grid = parseBoard(ENCLOSED);
    const moves = orderedMoves(grid, 'X');
    const contactsInvader = moves.some((m) => m.x === 3 && m.y === 2); // adjacent to O at (3,3)
    assert.ok(contactsInvader, 'must still be able to attack/capture the invader');
});

test('the opening is not over-pruned into a pass', () => {
    const empty = parseBoard(['.......', '.......', '.......', '.......', '.......', '.......', '.......']);
    assert.equal(orderedMoves(empty, 'X').length, 49); // no stones yet -> nothing to keep blank
});

test('selectMove plays a gaining move rather than passing, and never a self-fill', () => {
    const grid = parseBoard(ENCLOSED);
    const move = selectMove(grid, allValid(grid), 3, 12, () => 0);
    assert.notEqual(move, null, 'a position with a real gain (attack the invader) must not pass');
    assert.ok(!(move![0] === 1 && move![1] === 1), 'must not return the excluded deep self-fill');
});

test('selectMove passes when every empty point is settled (no candidates)', () => {
    // X alive (two eyes) on top, O alive (two eyes) on the bottom, no dame.
    const grid = parseBoard(['XXXXX', 'X.X.X', 'XXXXX', 'OOOOO', 'O.O.O']);
    assert.equal(orderedMoves(grid, 'X').length, 0); // nothing legal but self-harm
    assert.equal(selectMove(grid, allValid(grid), 3, 12, () => 0), null);
});

test('selectMove decision does not depend on the score (no isAhead gate)', () => {
    // Behind or ahead, the same board yields the same decision: a gaining move is
    // played, a settled board is passed. selectMove takes no score input at all.
    const fighting = parseBoard(ENCLOSED);
    const settled = parseBoard(['XXXXX', 'X.X.X', 'XXXXX', 'OOOOO', 'O.O.O']);
    assert.notEqual(selectMove(fighting, allValid(fighting), 3, 12, () => 0), null);
    assert.equal(selectMove(settled, allValid(settled), 3, 12, () => 0), null);
});

test('a frontier point closer to the enemy is not excluded as our self-fill', () => {
    // X wall on the left, O wall on the right, open middle. The point next to O
    // is the enemy's influence, not our territory, and must remain playable.
    const grid = parseBoard(['X.....O', 'X.....O', 'X.....O', 'X.....O', 'X.....O', 'X.....O', 'X.....O']);
    const moves = orderedMoves(grid, 'X');
    assert.ok(moves.some((m) => m.x === 3 && m.y === 5), 'reduction next to enemy must be allowed');
    assert.ok(moves.some((m) => m.x === 3 && m.y === 3), 'the neutral midline must be playable');
    assert.equal(moves.some((m) => m.x === 3 && m.y === 1), false, 'deep point in our own influence is kept blank');
});
