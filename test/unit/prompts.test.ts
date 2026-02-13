/**
 * Prompt Utilities Tests
 *
 * Note: These tests mock inquirer since prompts are interactive.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import inquirer from 'inquirer';
import {
  prompt,
  promptNumber,
  promptConfirm,
  promptChoice,
  promptMultiSelect,
  promptPassword,
} from '../../src/utils/prompts';

// Mock inquirer
vi.mock('inquirer');

describe('Prompt Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('prompt', () => {
    it('should return user input', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue({ value: 'user input' });

      const result = await prompt('Enter value:');

      expect(result).toBe('user input');
      expect(inquirer.prompt).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'input',
          name: 'value',
          message: 'Enter value:',
          default: undefined,
        }),
      ]);
    });

    it('should use default value', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue({ value: 'default' });

      await prompt('Enter value:', 'default');

      expect(inquirer.prompt).toHaveBeenCalledWith([
        expect.objectContaining({
          default: 'default',
        }),
      ]);
    });
  });

  describe('promptNumber', () => {
    it('should return number input', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue({ value: 42 });

      const result = await promptNumber('Enter number:');

      expect(result).toBe(42);
      expect(inquirer.prompt).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'number',
          name: 'value',
          message: 'Enter number:',
        }),
      ]);
    });

    it('should use default value', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue({ value: 10 });

      await promptNumber('Enter number:', 10);

      expect(inquirer.prompt).toHaveBeenCalledWith([
        expect.objectContaining({
          default: 10,
        }),
      ]);
    });

    it('should have validation function', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue({ value: 5 });

      await promptNumber('Enter number:');

      const call = vi.mocked(inquirer.prompt).mock.calls[0][0] as Array<{
        validate?: (input: number) => boolean | string;
      }>;
      const validateFn = call[0].validate;

      expect(validateFn).toBeDefined();
      expect(validateFn!(5)).toBe(true);
      expect(validateFn!(-1)).toBe('Please enter a valid positive number');
      expect(validateFn!(NaN)).toBe('Please enter a valid positive number');
    });
  });

  describe('promptConfirm', () => {
    it('should return boolean for confirmation', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue({ value: true });

      const result = await promptConfirm('Continue?');

      expect(result).toBe(true);
      expect(inquirer.prompt).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'confirm',
          name: 'value',
          message: 'Continue?',
          default: true,
        }),
      ]);
    });

    it('should use custom default value', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue({ value: false });

      await promptConfirm('Continue?', false);

      expect(inquirer.prompt).toHaveBeenCalledWith([
        expect.objectContaining({
          default: false,
        }),
      ]);
    });
  });

  describe('promptChoice', () => {
    it('should return selected choice', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue({ value: 'option2' });

      const result = await promptChoice('Select:', ['option1', 'option2', 'option3']);

      expect(result).toBe('option2');
      expect(inquirer.prompt).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'list',
          name: 'value',
          message: 'Select:',
          choices: ['option1', 'option2', 'option3'],
        }),
      ]);
    });
  });

  describe('promptMultiSelect', () => {
    it('should return array of selected choices', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue({ value: ['option1', 'option3'] });

      const result = await promptMultiSelect('Select multiple:', ['option1', 'option2', 'option3']);

      expect(result).toEqual(['option1', 'option3']);
      expect(inquirer.prompt).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'checkbox',
          name: 'value',
          message: 'Select multiple:',
          choices: ['option1', 'option2', 'option3'],
        }),
      ]);
    });

    it('should return empty array if nothing selected', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue({ value: [] });

      const result = await promptMultiSelect('Select multiple:', ['option1', 'option2']);

      expect(result).toEqual([]);
    });
  });

  describe('promptPassword', () => {
    it('should return password input with masking', async () => {
      vi.mocked(inquirer.prompt).mockResolvedValue({ value: 'secret123' });

      const result = await promptPassword('Enter password:');

      expect(result).toBe('secret123');
      expect(inquirer.prompt).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'password',
          name: 'value',
          message: 'Enter password:',
          mask: '*',
        }),
      ]);
    });
  });
});
