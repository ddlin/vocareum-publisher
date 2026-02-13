# Lab 1: Introduction to Python
# Welcome to your first Python lab!

def greet(name: str) -> str:
    """Return a greeting message.

    Args:
        name: The name to greet

    Returns:
        A greeting string
    """
    return f"Hello, {name}!"

def main():
    """Main entry point for the lab."""
    message = greet("World")
    print(message)

    # TODO: Add your code here
    # Try calling greet() with different names!

if __name__ == "__main__":
    main()
