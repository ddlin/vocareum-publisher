# Lab 2: Data Analysis - Part 2
# Data Visualization

def create_bar_chart(labels: list, values: list) -> str:
    """Create a simple ASCII bar chart.

    Args:
        labels: Labels for each bar
        values: Numeric values for each bar

    Returns:
        ASCII bar chart as a string
    """
    if not labels or not values:
        return "No data to display"

    max_value = max(values)
    max_label_len = max(len(str(label)) for label in labels)

    lines = []
    for label, value in zip(labels, values):
        bar_width = int((value / max_value) * 40) if max_value > 0 else 0
        bar = "█" * bar_width
        lines.append(f"{str(label):<{max_label_len}} | {bar} {value}")

    return "\n".join(lines)

def main():
    """Main entry point."""
    # Sample data
    categories = ["Electronics", "Books", "Furniture"]
    totals = [175, 400, 500]

    print("Category Totals")
    print("=" * 50)
    chart = create_bar_chart(categories, totals)
    print(chart)

    # TODO: Add your visualization code here

if __name__ == "__main__":
    main()
