# Lab 1: Hello World
# This is the starter code for the first lab

def main():
    """Main entry point for the lab."""
    print("Hello, Vocareum!")

    # TODO: Add your code here
    result = add_numbers(2, 3)
    print(f"2 + 3 = {result}")

def add_numbers(a: int, b: int) -> int:
    """Add two numbers together.

    Args:
        a: First number
        b: Second number

    Returns:
        Sum of a and b
    """
    return a + b

if __name__ == "__main__":
    main()
