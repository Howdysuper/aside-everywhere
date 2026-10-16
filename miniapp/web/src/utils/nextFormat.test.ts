import { describe, expect, it } from 'vitest';

describe('senderLine', async () => {
  const { senderLine } = await import('./nextFormat');
  it('says who really sent it', () => {
    expect(senderLine({ host: 'district.example.edu', tier: 'district' })).toBe('From the school, verified');
    expect(senderLine({ host: 'students.district.example.edu', tier: 'student' })).toBe('From a student account, students.district.example.edu');
    expect(senderLine({ host: 'district.example.edu', tier: 'outside' })).toBe('district.example.edu address, sender not confirmed');
    expect(senderLine({ host: 'win-now.biz', tier: 'outside' })).toBe('From outside the school, win-now.biz');
    expect(senderLine(null)).toBe('From school email');
  });
});
