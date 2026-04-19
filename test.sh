sudo chflags nouchg /etc/hosts
sudo chmod 644 /etc/hosts
echo '127.0.0.1 www.torproject.org' | sudo tee -a /etc/hosts

