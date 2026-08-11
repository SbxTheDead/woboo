# Woboo 100-Task Test Suite

Run these through the widget or Telegram. Log every result (pass/fail + what went wrong).
Categories exercise every part of the system: shell, browser, planner, brain, downloads, files, research, error handling.

---

## A. Shell & PowerShell (1-15)

1. create a folder called test_output on my desktop
2. create 5 empty text files named file1.txt through file5.txt in that folder
3. write "hello world" into file1.txt
4. rename file2.txt to file2_renamed.txt
5. copy file3.txt to file3_backup.txt
6. move file4.txt to my documents folder
7. delete file5.txt from the test_output folder
8. list all files on my desktop and tell me how many there are
9. what is my current username and computer name
10. show me the contents of my PATH environment variable
11. create a folder with spaces in the name like "my test folder" on the desktop
12. write a file with special characters: cafe, naive, resume with accents
13. what is the total size of all files in my downloads folder
14. find all .txt files in my documents folder recursively
15. create a nested folder structure: a/b/c/d/e and put a file in the deepest one

## B. Environment Variables & Paths (16-25)

16. create a file at TEMP directory called woboo_test.txt with some content
17. check if my Desktop folder exists
18. write a file to TEMP and then read it back
19. list what is in APPDATA
20. create a shortcut file on my desktop
21. what is my default browser
22. find where python is installed on my system
23. find where node is installed and what version
24. show me the contents of the hosts file in System32
25. create a batch file that echoes hello and run it

## C. Browser Navigation & Reading (26-40)

26. go to google.com and search for "woboo ai agent" and tell me the first 3 results
27. open hacker news and tell me the top 5 stories
28. go to wikipedia.org and search for "artificial intelligence" give me the first paragraph
29. open example.com and take a screenshot
30. go to duckduckgo and search for "best pizza in new york" read the top 3 results
31. open github.com and search for repositories about "ai agent" list the top 5 by stars
32. go to reddit programming subreddit and tell me the top 5 posts
33. navigate to httpbin.org/html and read the page content
34. go to jsonplaceholder users endpoint and tell me how many users there are
35. open the French wikipedia and read the main page title
36. go to stackoverflow and search for "javascript array sort" give me the top answer
37. open caniuse.com and check if WebAssembly is supported
38. go to w3schools javascript section and tell me what the sidebar navigation items are
39. open httpbin forms post page fill in the form with test data and submit it
40. go to google maps and search for "Eiffel Tower" tell me the coordinates

## D. Browser Downloads (41-50)

41. download the VS Code installer for Windows
42. download a test PDF from w3.org test files
43. download the latest Node.js installer for Windows
44. download the Python installer from python.org
45. download the w3c home page image as a PNG
46. download the 7-Zip installer
47. download the Notepad++ installer
48. download a text file from textfiles.com
49. download the Git installer for Windows
50. download the Discord installer

## E. Research & Compose (51-65)

51. research the top 5 AI frameworks in 2025 and write a one-page summary
52. research how to set up a home server and write a guide
53. find me 10 remote job boards for developers and list them
54. research the history of the JavaScript programming language
55. what are the differences between REST and GraphQL write a comparison
56. research the best practices for securing a Windows PC
57. find 5 free online courses about machine learning and list them with links
58. research how blockchain works and explain it simply
59. what are the pros and cons of working from home write a short report
60. research the latest version of Windows and its new features
61. find 3 recipes for chocolate cake and combine them into the best one
62. research electric cars available under 30000 dollars and compare them
63. what are the top 5 VS Code extensions for Python development
64. research how to start a YouTube channel and write a step by step guide
65. find the current weather in 5 major world cities

## F. File Creation & Documents (66-75)

66. write a hello world HTML page and save it to my desktop
67. create a JSON file with a list of 5 countries and their capitals
68. write a Python script that prints hello world and save it
69. create a CSV file with columns name age city and 5 rows of sample data
70. write a markdown file with a table comparing 3 programming languages
71. create a simple CSS file with styles for a centered card layout
72. write a batch script that lists all files in the current directory
73. create a .env file with sample API keys using fake values
74. write a simple Express.js server in one file
75. create a README.md for a project called my-app with sections install usage license

## G. Multi-Step & Complex Tasks (76-85)

76. download an image from the web and save a report about it
77. search for the top 5 GitHub repos about AI then create a markdown file listing them with descriptions
78. check if node is installed if not download it then create a hello world express server and test it
79. research 3 pizza recipes combine them into one HTML document and save it to my desktop
80. create a folder called project initialize a git repo create a README and make the first commit
81. find my 5 most recent downloads list them with their sizes and move the oldest to a backup folder
82. check my system info OS version RAM CPU and write a report to a text file
83. search for a free API fetch data from it and save the results as JSON
84. create a to-do list app in a single HTML file with JavaScript
85. download 3 different images from the web and save them in a folder called images

## H. Error Handling & Edge Cases (86-95)

86. open a website that does not exist like https://thisisnotarealwebsite12345.com
87. download a file from a broken URL
88. read a file that does not exist at C:\nonexistent\file.txt
89. run a command that will fail like divide by zero in PowerShell
90. search for something with special characters like script tag alert xss
91. create a file with a very long name over 200 characters
92. create 100 files in a folder and then list them all
93. try to delete a folder that does not exist
94. open a website in a language you do not know and try to read it
95. do a task then immediately ask to undo it

## I. Telegram & Delivery (96-100)

96. create a text file and send it to me on telegram
97. research something and send me the report on telegram
98. take a screenshot and send it to me
99. create an HTML file then send me a summary of it on telegram
100. send me a list of the last 5 missions you completed

---

## How to run

Give each task to Woboo one at a time through the widget or Telegram.
Record:
- Task number
- Pass or Fail
- If fail: what error, what step failed, what the log said
- Time taken roughly

After all 100, group the failures by category and fix the most common patterns first.
