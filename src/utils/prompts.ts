/**
 * Prompt Utilities
 *
 * Interactive prompts using inquirer library.
 */

import inquirer from 'inquirer';

/**
 * Prompt for text input
 *
 * @param message - Prompt message
 * @param defaultValue - Default value
 * @returns User input
 */
export async function prompt(message: string, defaultValue?: string): Promise<string> {
  const answers = await inquirer.prompt<{ value: string }>([
    {
      type: 'input',
      name: 'value',
      message,
      default: defaultValue,
    },
  ]);
  return answers.value;
}

/**
 * Prompt for number input
 *
 * @param message - Prompt message
 * @param defaultValue - Default value
 * @returns Number input
 */
export async function promptNumber(message: string, defaultValue?: number): Promise<number> {
  const answers = await inquirer.prompt<{ value: number }>([
    {
      type: 'number',
      name: 'value',
      message,
      default: defaultValue,
      validate: (input: number): boolean | string => {
        if (isNaN(input) || input < 0) {
          return 'Please enter a valid positive number';
        }
        return true;
      },
    },
  ]);
  return answers.value;
}

/**
 * Prompt for yes/no confirmation
 *
 * @param message - Prompt message
 * @param defaultValue - Default value
 * @returns Boolean answer
 */
export async function promptConfirm(message: string, defaultValue: boolean = true): Promise<boolean> {
  const answers = await inquirer.prompt<{ value: boolean }>([
    {
      type: 'confirm',
      name: 'value',
      message,
      default: defaultValue,
    },
  ]);
  return answers.value;
}

/**
 * Prompt for single choice from list
 *
 * @param message - Prompt message
 * @param choices - Available choices
 * @returns Selected choice
 */
export async function promptChoice(message: string, choices: string[]): Promise<string> {
  const answers = await inquirer.prompt<{ value: string }>([
    {
      type: 'list',
      name: 'value',
      message,
      choices,
    },
  ]);
  return answers.value;
}

/**
 * Prompt for multiple selections
 *
 * @param message - Prompt message
 * @param choices - Available choices
 * @returns Array of selected choices
 */
export async function promptMultiSelect(message: string, choices: string[]): Promise<string[]> {
  const answers = await inquirer.prompt<{ value: string[] }>([
    {
      type: 'checkbox',
      name: 'value',
      message,
      choices,
    },
  ]);
  return answers.value;
}

/**
 * Prompt for password (hidden input)
 *
 * @param message - Prompt message
 * @returns Password input
 */
export async function promptPassword(message: string): Promise<string> {
  const answers = await inquirer.prompt<{ value: string }>([
    {
      type: 'password',
      name: 'value',
      message,
      mask: '*',
    },
  ]);
  return answers.value;
}
