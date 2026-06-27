import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseBoard,
    groupAt,
    playStone,
    secureTerritoryMask,
    rankMoves,
    expandMove,
    evaluateBoard,
    selectMove,
    EVAL,
    INFLUENCE_MARGIN,
    SHAPE,
    TACTIC,
    shapeScore,
    type Grid,
} from '../src/utils/go-engine.ts';

const allValid = (grid: Grid): boolean[][] => grid.map((row) => row.map(() => true));

// An X wall fully enclosing a 5x5 interior, with one lone O reduction stone in
// the middle. The interior empties are morally X's territory/eye space.
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
// Rules engine — preserved behavior.
// ---------------------------------------------------------------------------

test('groupAt counts a connected group and its liberties', () => {
    const grid = parseBoard(['XX.', '...', '...']);
    const g = groupAt(grid, 0, 0);
    assert.equal(g.cells.length, 2);
    assert.equal(g.liberties, 3);
});

test('playStone captures an enemy group reduced to zero liberties', () => {
    const grid = parseBoard(['.X.', 'XO.', '.X.']);
    const played = playStone(grid, 1, 2, 'X');
    assert.ok(played);
    assert.equal(played!.captured, 1);
    assert.equal(played!.grid[1][1], '.');
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
    assert.equal(mask[0][0], false);
});

test('evaluateBoard credits sealed territory to its owner', () => {
    const grid = parseBoard(['XXXXX', 'X...X', 'X...X', 'X...X', 'XXXXX']);
    assert.ok(evaluateBoard(grid) > 0);
});

test('stone and territory are weighted equally (true area scoring)', () => {
    assert.equal(EVAL.STONE, EVAL.TERRITORY);
    assert.equal(INFLUENCE_MARGIN, 2);
});

test('a symmetric position evaluates to zero', () => {
    assert.equal(evaluateBoard(parseBoard(['X.O', '...', '...'])), 0);
    assert.equal(evaluateBoard(parseBoard(['XX...OO', '.......', '.......', '.......', '.......', '.......', '.......'])), 0);
});

test('a one-colour-enclosed region still counts as territory under the margin', () => {
    assert.ok(evaluateBoard(parseBoard(['XXXXXXX', 'X.....X', 'X.....X', 'X.....X', 'X.....X', 'X.....X', 'XXXXXXX'])) > 0);
});

test('an empty board is neutral (cells unreachable by both colours count for nobody)', () => {
    // Guards the Infinity edge: a cell with distX == distO == Infinity must NOT be
    // credited to X (Infinity + margin <= Infinity would otherwise be true).
    assert.equal(evaluateBoard(parseBoard(['...', '...', '...'])), 0);
});

test('filling our own settled territory is not a gain', () => {
    const before = parseBoard(ENCLOSED);
    const played = playStone(before, 1, 1, 'X');
    assert.ok(played);
    assert.ok(
        evaluateBoard(played!.grid) <= evaluateBoard(before),
        'filling own territory must not increase value',
    );
});

// ---------------------------------------------------------------------------
// Move ordering — rankMoves (cheap candidate ranking) + expandMove (exact score).
// ---------------------------------------------------------------------------

test('rankMoves surfaces a capture as the top candidate', () => {
    const grid = parseBoard(['.X.', 'XO.', '.X.']);
    const moves = rankMoves(grid, 'X');
    assert.ok(moves.length > 0);
    assert.equal(moves[0].x, 1);
    assert.equal(moves[0].y, 2); // capturing the O ranks first
});

test('rankMoves does not offer a deep self-fill of our own territory', () => {
    const grid = parseBoard(ENCLOSED);
    const moves = rankMoves(grid, 'X');
    assert.equal(moves.some((m) => m.x === 1 && m.y === 1), false);
});

test('rankMoves still offers moves that contact the invader', () => {
    const grid = parseBoard(ENCLOSED);
    const moves = rankMoves(grid, 'X');
    assert.ok(moves.some((m) => m.x === 3 && m.y === 2));
});

test('the opening is not over-pruned (every empty point is a candidate)', () => {
    const empty = parseBoard(['.......', '.......', '.......', '.......', '.......', '.......', '.......']);
    assert.equal(rankMoves(empty, 'X').length, 49);
});

test('a frontier point closer to the enemy is not excluded as our self-fill', () => {
    const grid = parseBoard(['X.....O', 'X.....O', 'X.....O', 'X.....O', 'X.....O', 'X.....O', 'X.....O']);
    const moves = rankMoves(grid, 'X');
    assert.ok(moves.some((m) => m.x === 3 && m.y === 5), 'reduction next to enemy must be allowed');
    assert.ok(moves.some((m) => m.x === 3 && m.y === 3), 'the neutral midline must be playable');
    assert.equal(moves.some((m) => m.x === 3 && m.y === 1), false, 'deep point in our own influence is kept blank');
});

test('expandMove scores a capture far above a quiet move', () => {
    const grid = parseBoard(['.X.', 'XO.', '.X.']);
    const cap = expandMove(grid, 1, 2, 'X');
    assert.ok(cap);
    assert.ok(cap!.ord >= 1000, `capture should score >= 1000, got ${cap!.ord}`);
});

test('expandMove rejects a suicide as null', () => {
    const grid = parseBoard(['.O.', 'O.O', '.O.']);
    assert.equal(expandMove(grid, 1, 1, 'X'), null);
});

test('expandMove heavily penalizes self-atari', () => {
    const grid = parseBoard(['OO.', 'O..', '...']);
    const e = expandMove(grid, 0, 2, 'X'); // 1-liberty stone, captures nothing
    assert.ok(e);
    assert.ok(e!.ord < 0, `self-atari should score negative, got ${e!.ord}`);
});

test('shapeScore: a straight connection of two groups is rewarded', () => {
    // Playing the middle of X.X joins two distinct one-stone groups in a straight line.
    assert.equal(shapeScore(parseBoard(['X.X', '...', '...']), 0, 1, 'X'), SHAPE.CONNECT);
});

test('shapeScore: an empty triangle is penalised (bad-shaped connection)', () => {
    // Playing (1,1) joins the two diagonal stones but forms an empty triangle
    // (corner (0,0) empty): CONNECT - EMPTY_TRIANGLE, net negative.
    assert.equal(shapeScore(parseBoard(['.X.', 'X..', '...']), 1, 1, 'X'), SHAPE.CONNECT - SHAPE.EMPTY_TRIANGLE);
});

test('shapeScore: a hane turning around an enemy stone in contact is rewarded', () => {
    // (1,1) is diagonal to the enemy at (0,0) and shares the own stone at (1,0).
    assert.equal(shapeScore(parseBoard(['O..', 'X..', '...']), 1, 1, 'X'), SHAPE.HANE);
});

test('shapeScore: a plain move with no neighbours scores zero', () => {
    assert.equal(shapeScore(parseBoard(['..', '..']), 0, 0, 'X'), 0);
});

test('shapeScore is folded into expandMove ord', () => {
    // (0,1) connects the two X groups in a straight line (+CONNECT). The own group
    // then has 3 liberties, so the tactical base is only 3*5=15 — the ord clearing
    // SHAPE.CONNECT proves the shape bonus was added.
    const e = expandMove(parseBoard(['X.X', '...', '...']), 0, 1, 'X');
    assert.ok(e);
    assert.ok(e!.ord >= SHAPE.CONNECT, `connection shape bonus should be in ord, got ${e!.ord}`);
});

test('expandMove rewards putting an enemy group in atari (offense)', () => {
    // O at (1,1) has 2 liberties; playing X (1,2) leaves it with 1 (atari, not captured).
    const e = expandMove(parseBoard(['.X.', 'XO.', '...']), 1, 2, 'X');
    assert.ok(e);
    assert.ok(e!.ord >= TACTIC.ATARI_THREAT, `atari threat should be scored, got ${e!.ord}`);
});

test('expandMove rewards lifting a weak (2-liberty) own group to safety (defense)', () => {
    // X (0,0) has 2 liberties; playing X (0,1) raises the group to 3 liberties.
    const e = expandMove(parseBoard(['X..', '...', '...']), 0, 1, 'X');
    assert.ok(e);
    assert.ok(e!.ord >= TACTIC.DEFEND_WEAK, `defense should be scored, got ${e!.ord}`);
});

// ---------------------------------------------------------------------------
// selectMove — plays gains, passes when settled, ignores self-fill, score-blind.
// ---------------------------------------------------------------------------

test('selectMove plays a gaining move rather than passing, and never a self-fill', () => {
    const grid = parseBoard(ENCLOSED);
    const move = selectMove(grid, allValid(grid), 4, 12, 12, () => 0);
    assert.notEqual(move, null);
    assert.ok(!(move![0] === 1 && move![1] === 1), 'must not return the excluded deep self-fill');
});

test('selectMove passes when every empty point is settled', () => {
    // X alive (two eyes) on top; O alive (two eyes) on the bottom; no dame. Our
    // eyes are secure territory and the opponent's eyes are suicide for us, so
    // there is no legal, non-self-harming move -> selectMove must pass.
    const grid = parseBoard(['XXXXX', 'X.X.X', 'XXXXX', 'OOOOO', 'O.O.O']);
    assert.equal(selectMove(grid, allValid(grid), 4, 12, 12, () => 0), null);
});

test('selectMove decision does not depend on the score (no isAhead gate)', () => {
    const fighting = parseBoard(ENCLOSED);
    const settled = parseBoard(['XXXXX', 'X.X.X', 'XXXXX', 'OOOOO', 'O.O.O']);
    assert.notEqual(selectMove(fighting, allValid(fighting), 4, 12, 12, () => 0), null);
    assert.equal(selectMove(settled, allValid(settled), 4, 12, 12, () => 0), null);
});

test('selectMove never returns a move the game marks invalid', () => {
    // The capturing move (1,2) is the strongest, but if the game forbids it (ko),
    // selectMove must not return it.
    const grid = parseBoard(['.X.', 'XO.', '.X.']);
    const valid = allValid(grid);
    valid[1][2] = false;
    const move = selectMove(grid, valid, 4, 12, 12, () => 0);
    assert.ok(move === null || !(move[0] === 1 && move[1] === 2));
});

// ---------------------------------------------------------------------------
// Regression guards for the headline fixes (positions verified against the
// engine itself, not hand-guessed). Both assert the decision *changes*, which is
// what would silently break if depth regressed to odd/shallow or the beam to too narrow.
// ---------------------------------------------------------------------------

test('a deeper search changes the chosen move (horizon parity)', () => {
    // At depth 2 the search evaluates right after our own move; at depth 4 it sees
    // the opponent's reply and prefers a different move. Guards the even-depth fix.
    const grid = parseBoard(['.O.O.', 'O.OO.', '.OO..', 'XXX..', 'OO..X']);
    const valid = allValid(grid);
    const shallow = selectMove(grid, valid, 2, 12, 12, () => 0);
    const deep = selectMove(grid, valid, 4, 12, 12, () => 0);
    assert.ok(shallow && deep, 'both depths should play a move on this position');
    assert.notDeepEqual(shallow, deep, 'search depth must influence the chosen move');
});

test('a wider beam changes the chosen move (no forward-pruning a tactic)', () => {
    // A narrow beam prunes, sight-unseen, the move a wide beam plays. Guards the
    // board-scaled wide beam against a regression to a too-narrow one.
    const grid = parseBoard(['XOO.X', 'OX..X', '..OO.', 'XXX.O', 'XOX.X']);
    const valid = allValid(grid);
    const narrow = selectMove(grid, valid, 4, 2, 2, () => 0);
    const wide = selectMove(grid, valid, 4, 25, 25, () => 0);
    assert.ok(narrow && wide, 'both beam widths should play a move on this position');
    assert.notDeepEqual(narrow, wide, 'beam width must influence the chosen move');
});
