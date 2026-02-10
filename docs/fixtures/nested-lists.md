# Nested List Test Fixture

Use this fixture to verify list rendering on small screens (iPhone SE, etc.).

## Unordered Lists (4 levels)

- Level 1 item A
  - Level 2 item A.1
    - Level 3 item A.1.1
      - Level 4 item A.1.1.1
      - Level 4 item A.1.1.2
    - Level 3 item A.1.2
  - Level 2 item A.2
- Level 1 item B
  - Level 2 item B.1
    - Level 3 item B.1.1
      - Level 4 item B.1.1.1

## Ordered Lists (4 levels)

1. First top-level item
   1. Nested ordered A
      1. Deep ordered A.1
         1. Deepest ordered A.1.1
         2. Deepest ordered A.1.2
      2. Deep ordered A.2
   2. Nested ordered B
2. Second top-level item
   1. Nested ordered C
      1. Deep ordered C.1
         1. Deepest ordered C.1.1

## Task Lists (4 levels)

- [ ] Unchecked level 1
  - [x] Checked level 2
    - [ ] Unchecked level 3
      - [x] Checked level 4
      - [ ] Unchecked level 4
    - [x] Checked level 3
  - [ ] Unchecked level 2
- [x] Checked level 1

## Mixed List Types

- Unordered parent
  1. Ordered child
     - [ ] Task grandchild
       - Deep unordered
  2. Another ordered child
     - [x] Completed task
- Another unordered
  - [ ] Task child
    1. Ordered grandchild
       1. Deepest ordered
