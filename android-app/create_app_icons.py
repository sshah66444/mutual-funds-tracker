import os
from PIL import Image, ImageDraw

# Paths
base_image_path = "/Users/syed/.gemini/antigravity/brain/35f4d109-8603-4926-ac53-fcaa84f8281f/app_icon_base_1783946901016.jpg"
res_dir = "/Users/syed/.gemini/antigravity/scratch/pk-mutual-funds-tracker/android-app/app/src/main/res"

# Dimensions for mipmap sizes
sizes = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192
}

def create_circular_icon(img):
    # Ensure image has alpha channel
    img = img.convert("RGBA")
    # Create mask
    mask = Image.new("L", img.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0) + img.size, fill=255)
    
    # Create output
    output = Image.new("RGBA", img.size, (0, 0, 0, 0))
    output.paste(img, (0, 0), mask=mask)
    return output

def main():
    if not os.path.exists(base_image_path):
        print(f"Base image not found at {base_image_path}")
        return
    
    # Remove adaptive icon files so Android falls back to legacy mipmaps
    adaptive_files = [
        os.path.join(res_dir, "mipmap-anydpi-v26", "ic_launcher.xml"),
        os.path.join(res_dir, "mipmap-anydpi-v26", "ic_launcher_round.xml"),
        os.path.join(res_dir, "drawable", "ic_launcher_foreground.xml"),
        os.path.join(res_dir, "drawable", "ic_launcher_background.xml")
    ]
    
    for f in adaptive_files:
        if os.path.exists(f):
            os.remove(f)
            print(f"Removed adaptive configuration: {f}")

    # Load base image
    img = Image.open(base_image_path)
    
    for folder, size in sizes.items():
        folder_path = os.path.join(res_dir, folder)
        os.makedirs(folder_path, exist_ok=True)
        
        # 1. Square/Regular Launcher Icon
        resized_img = img.resize((size, size), Image.Resampling.LANCZOS)
        square_output = os.path.join(folder_path, "ic_launcher.webp")
        # Save as WEBP (transparency supported in RGBA mode)
        resized_img.convert("RGB").save(square_output, "WEBP", quality=95)
        print(f"Saved square launcher to {square_output} ({size}x{size})")
        
        # 2. Round Launcher Icon
        circular_img = create_circular_icon(resized_img)
        round_output = os.path.join(folder_path, "ic_launcher_round.webp")
        circular_img.save(round_output, "WEBP", quality=95)
        print(f"Saved round launcher to {round_output} ({size}x{size})")

    print("\nIcon creation completed successfully!")

if __name__ == "__main__":
    main()
