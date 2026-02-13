# Lab 2: Data Analysis - Part 1
# Loading and exploring data

import csv
from typing import List, Dict

def load_csv(filename: str) -> List[Dict[str, str]]:
    """Load data from a CSV file.

    Args:
        filename: Path to the CSV file

    Returns:
        List of dictionaries, one per row
    """
    data = []
    with open(filename, 'r', newline='') as f:
        reader = csv.DictReader(f)
        for row in reader:
            data.append(dict(row))
    return data

def summarize_data(data: List[Dict[str, str]]) -> Dict[str, int]:
    """Create a summary of the data.

    Args:
        data: List of data rows

    Returns:
        Summary statistics
    """
    return {
        "total_rows": len(data),
        "total_columns": len(data[0]) if data else 0,
    }

def main():
    """Main entry point."""
    # Load the sample data
    data = load_csv("data/sample.csv")

    # Print summary
    summary = summarize_data(data)
    print(f"Loaded {summary['total_rows']} rows")
    print(f"Found {summary['total_columns']} columns")

    # TODO: Add your analysis code here

if __name__ == "__main__":
    main()
